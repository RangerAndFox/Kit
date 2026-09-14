import { randomUUID } from 'node:crypto'
import type { App } from '@slack/bolt'
import { WebClient } from '@slack/web-api'
import type { KnownBlock } from '@slack/types'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { projectNumberFromCode } from '../../../src/lib/studio-knowledge/project-sync'
import { commandActor, canUseCommand } from '../handlers/natural-commands'
import { beginOnboarding, prepareOffboarding, readOffboarding, claimOffboarding } from '../../../src/lib/artist-access/store'
import { createArtistRemovalAdapters } from '../../../src/lib/artist-access/providers'
import { runOffboarding, defaultOffboardingStore } from '../../../src/lib/artist-access/workflow'
import { OFFBOARD_STEPS, safeLabel, type Engagement, type OffboardRequest, type OffboardSnapshot } from '../../../src/lib/artist-access/types'
import { workbookConfigFromEnv } from '../../../src/lib/project-control/types'

type Client = App['client']
type Identity = { workspace: string; actor: string; dm: string }
type ActionBody = { user: {id:string}; team?: {id?:string}; channel?: {id?:string}; message?: {ts?:string} }
type Action = { action_id: string; value?: string; selected_option?: {value:string} }
type Project = {id:string;name:string;project_code:string|null;external_links:unknown}
const db = () => createAdminClient()
const object = (value: unknown) => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {}
const button = (label:string, action:string, value:string) => ({type:'button' as const,text:{type:'plain_text' as const,text:label},action_id:`kit_offboard_${action}`,value})
const section = (text:string): KnownBlock => ({type:'section',text:{type:'mrkdwn',text}})

export async function offboardingIdentity(client: Client, actor: string, team: string): Promise<Identity> {
  const resolved = await commandActor(client,actor,team)
  if (!canUseCommand(resolved.user.tier,'offboard')) throw new Error('Offboarding is producer/admin only.')
  const dm = await client.conversations.open({users:actor})
  if (!dm.ok || !dm.channel?.id?.startsWith('D')) throw new Error('Private conversation unavailable')
  return {workspace:resolved.user.workspaceId,actor,dm:dm.channel.id}
}
async function projects(identity: Identity): Promise<Project[]> {
  const {data,error} = await db().from('projects').select('id,name,project_code,external_links').eq('workspace_id',identity.workspace).order('name').limit(101)
  if (error || (data || []).length>100) throw new Error('Project picker needs administrator review')
  return data || []
}
async function post(client: Client, identity: Identity, blocks: KnownBlock[], ts?: string) {
  const payload = {channel:identity.dm,text:'Artist offboarding — project access only',blocks}
  if (ts) await client.chat.update({...payload,ts})
  else await client.chat.postMessage({...payload,unfurl_links:false,unfurl_media:false})
}
export async function openOffboarding(client: Client, actor: string, team: string, hint = '') {
  const identity = await offboardingIdentity(client,actor,team)
  const rows = await projects(identity)
  if (!rows.length) { await post(client,identity,[section('No projects are available to offboard from.')]); return }
  await post(client,identity,[section('*Offboard an artist from a project*\nChoose the exact project, then the artist. Nothing is removed until you confirm.'),
    ...(hint ? [section(`Your request: ${safeLabel(hint.slice(0,500))}\nThe picker below determines the actual target.`)] : []),
    {type:'actions',elements:[{type:'static_select',action_id:'kit_offboard_project',placeholder:{type:'plain_text',text:'Choose project'},options:rows.map(p=>({text:{type:'plain_text',text:`${projectNumberFromCode(p.project_code)} — ${p.name}`.slice(0,75)},value:p.id}))}]}])
}
async function chooseArtist(client: Client, identity: Identity, projectId: string, ts?: string) {
  if (!(await projects(identity)).some(p=>p.id===projectId)) throw new Error('Project unavailable')
  const {data,error} = await db().from('freelancer_onboardings').select('id,artist_name,artist_email').eq('project_id',projectId).order('created_at',{ascending:false}).limit(1001)
  if (error || (data || []).length>1000) throw new Error('Artist history needs administrator review')
  const unique = [...new Map((data || []).map(row=>[row.artist_email.trim().toLowerCase(),row])).values()]
  if (!unique.length || unique.length>100) { await post(client,identity,[section('No unambiguous onboarding roster is available. Ask an administrator to reconcile project access; nothing has been removed.')],ts); return }
  await post(client,identity,[section('*Choose the artist*\nKit uses their recorded email and project identity—not a guessed name.'),
    {type:'actions',elements:[{type:'static_select',action_id:'kit_offboard_artist',placeholder:{type:'plain_text',text:'Choose artist'},options:unique.map(row=>({text:{type:'plain_text',text:`${row.artist_name} · ${row.artist_email}`.slice(0,75)},value:`${projectId}:${row.id}`}))},button('Cancel','dismiss','none')]}],ts)
}
async function snapshotFor(identity: Identity, projectId: string, onboardingId: string): Promise<OffboardSnapshot> {
  const project = (await projects(identity)).find(p=>p.id===projectId)
  if (!project) throw new Error('Project unavailable')
  const {data:history,error} = await db().from('freelancer_onboardings').select('artist_name,artist_email,artist_slack_user_id').eq('id',onboardingId).eq('project_id',projectId).maybeSingle()
  if (error || !history) throw new Error('Artist identity unavailable')
  const {data:members,error:membersError}=await db().from('team_members').select('email,role').eq('workspace_id',identity.workspace)
  if (membersError || (members || []).some(member=>member.email.trim().toLowerCase()===history.artist_email.trim().toLowerCase() && !['artist','freelancer'].includes(member.role))) throw new Error('The selected person has a privileged Kit role; offboarding is for project artists only.')
  if (!history.artist_name) throw new Error('Artist name needs producer correction before offboarding.')
  const {engagement} = await beginOnboarding(identity.workspace,projectId,history.artist_email,history.artist_name,identity.actor,true)
  if (engagement.state!=='active') throw new Error('Artist access is already held or ended. Review the existing offboarding/checkpoint before starting another one.')
  // Persisted provider IDs win. Legacy email identity must be reconciled at each provider.
  const links = object(project.external_links)
  const e: Engagement = {...engagement,artist_slack_id:engagement.artist_slack_id || history.artist_slack_user_id}
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:process.env.STUDIO_TIMEZONE || 'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
  const yesterday = new Date(`${today}T12:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate()-1)
  return {engagement:e,projectName:project.name,projectNumber:projectNumberFromCode(project.project_code) || '',
    slackChannel:String(links.slack_id || links.slack_channel_id || ''),dropboxPath:String(links.dropbox_id || links.dropbox_path || ''),
    frameioProject:String(links.frameio_id || links.frameio_project_id || ''),frameioAccount:process.env.FRAMEIO_ACCOUNT_ID,
    assignmentsConfigured:workbookConfigFromEnv()?.assignmentsSheetId!=null,lastWorkingDate:yesterday.toISOString().slice(0,10)}
}
export function offboardingReview(request: OffboardRequest): KnownBlock[] {
  const s = request.snapshot
  return [section(`*Offboard ${safeLabel(s.engagement.artist_name)} from ${safeLabel(s.projectNumber)} — ${safeLabel(s.projectName)}?*\n${safeLabel(s.engagement.artist_email)}\n\n• Remove only project-channel, Dropbox and Frame.io memberships.\n• End project-specific Kit access; flag current/future assignments for reassignment.\n• Keep all files, messages, time, NDA records, the People roster and other projects.\n• Keep the shared Harvest Freelancers account.\n\n*Limitations:* public channels/links, downloaded copies, inherited access and pending external invitations may require manual review. Kit will not disconnect an entire organization or revoke shared links used by others.\n\nNothing has been removed. This review expires in 30 minutes.`),
    {type:'actions',elements:[{...button('Offboard','confirm',request.id),style:'danger',confirm:{title:{type:'plain_text',text:'Remove project access?'},text:{type:'plain_text',text:`Remove ${s.engagement.artist_name} from ${s.projectNumber} now? Other projects and historical work will remain.`},confirm:{type:'plain_text',text:'Offboard'},deny:{type:'plain_text',text:'Cancel'}}},button('Edit','edit',request.id),button('Cancel','cancel',request.id)]}]
}
export function offboardingOutcome(request: OffboardRequest): KnownBlock[] {
  const lines = OFFBOARD_STEPS.map(step=>{const r=request.results[step]; return `• *${step.replace('_',' ')}:* ${r ? `${r.status} — ${safeLabel(r.detail)}` : 'Not verified'}`})
  const blocks: KnownBlock[] = [section(`*${request.status==='complete'?'Project memberships removed':'Offboarding needs attention'}*\n${safeLabel(request.snapshot.engagement.artist_name)} · ${safeLabel(request.snapshot.projectNumber)}\n\n${lines.join('\n')}\n\nHistorical work, other projects and the shared People/Harvest accounts remain intact.`)]
  if (request.status!=='complete') blocks.push({type:'actions',elements:[button('Retry failed steps','retry',request.id)]})
  return blocks
}
export function registerOffboardingHandlers(app: App): void {
  app.action(/^kit_offboard_(project|artist|confirm|retry|edit|cancel|dismiss)$/,async ({ack,body,action,client})=>{
    await ack()
    const b=body as unknown as ActionBody; const a=action as unknown as Action
    let identity: Identity | undefined
    try {
      identity=await offboardingIdentity(client,b.user.id,b.team?.id || '')
      if (b.channel?.id!==identity.dm) throw new Error('Use the private offboarding card')
      const value=a.selected_option?.value || a.value || ''; const op=a.action_id.slice('kit_offboard_'.length)
      if (op==='dismiss') {await post(client,identity,[section('Cancelled. Nothing removed.')],b.message?.ts);return}
      if (op==='project') {await chooseArtist(client,identity,value,b.message?.ts);return}
      if (op==='artist') {
        const [project,id]=value.split(':'); const snapshot=await snapshotFor(identity,project,id)
        const request=await prepareOffboarding(snapshot,identity.actor)
        await post(client,identity,offboardingReview(request),b.message?.ts);return
      }
      const request=await readOffboarding(value,identity.workspace,identity.actor)
      if (op==='cancel' || op==='edit') {
        await claimOffboarding(request,randomUUID(),true)
        if (op==='edit') await chooseArtist(client,identity,request.snapshot.engagement.project_id,b.message?.ts)
        else await post(client,identity,[section('Cancelled. Nothing removed.')],b.message?.ts)
        return
      }
      if (!client.token) throw new Error('Verified Slack credentials unavailable')
      // Do not let SDK retries keep an old revocation worker alive indefinitely.
      const boundedSlack = new WebClient(client.token,{timeout:15000,retryConfig:{retries:0},rejectRateLimitedCalls:true})
      const adapters=createArtistRemovalAdapters(boundedSlack)
      const outcome=await runOffboarding(request,{...defaultOffboardingStore,run:(step,r,before)=>adapters(step,r.snapshot,before)})
      await post(client,identity,offboardingOutcome(outcome),b.message?.ts)
    } catch {
      // This may follow a provider success + failed DB acknowledgement. Never
      // claim nothing changed and never expose raw error text to a shared channel.
      if (identity) await post(client,identity,[section('Offboarding could not finish safely. Access may still exist. Use the original review/retry card or ask an administrator to inspect the saved access checkpoint. No global account or project files were deleted.')]).catch(()=>{})
      console.warn('[artist-offboarding] request_needs_review')
    }
  })
}
