import { dropboxHeaders } from '../dropbox/client'
import { frameioHeaders } from '../frameio/auth'
import { frameUserRoles } from '../frameio/user-roles'
import { createAdminClient } from '../supabase/admin'
import { recordArtistOffboardingInSheet } from '../project-control/sheets'
import { workbookConfigFromEnv } from '../project-control/types'
import { identityEmail, type OffboardSnapshot, type OffboardStep, type StepResult } from './types'

type SlackApi = { apiCall(method: string, options: Record<string, unknown>): Promise<unknown> }
type ObjectData = Record<string, unknown>
const object = (value: unknown): ObjectData => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectData : {}
const list = (value: unknown): ObjectData[] => Array.isArray(value) ? value.map(object) : []
const review = (detail: string): StepResult => ({status:'review',detail})
const removed = (detail: string): StepResult => ({status:'removed',detail})
const retained = (detail: string): StepResult => ({status:'retained',detail})
async function json(response: Response): Promise<ObjectData> {
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}`)
  return response.status === 204 ? {} : object(await response.json())
}

export async function removeSlackArtist(slack: SlackApi, snapshot: OffboardSnapshot, beforeWrite: () => Promise<void>): Promise<StepResult> {
  if (snapshot.engagement.grants.slack?.resource && snapshot.engagement.grants.slack.resource!==snapshot.slackChannel) return review('Recorded Slack grant differs from the current project channel; reconcile it manually.')
  const channel = snapshot.engagement.grants.slack?.resource || snapshot.slackChannel
  if (!channel) return review('No verified project channel. Check the legacy invitation manually.')
  const info = object(await slack.apiCall('conversations.info',{channel}))
  if (!info.ok) throw new Error('Slack channel unavailable')
  const conversation = object(info.channel)
  if (conversation.is_general) return review('General channel retained. Project offboarding cannot remove studio-wide access.')
  // Slack Connect is not an organization-wide removal: kick targets one channel/user.
  const connected = Boolean(conversation.is_ext_shared || conversation.is_pending_ext_shared)
  let localTeam = ''
  if (connected) {
    const auth = object(await slack.apiCall('auth.test',{}))
    localTeam = String(auth.team_id || '')
    if (!auth.ok || !localTeam || conversation.conversation_host_id !== localTeam) return review('Slack Connect channel is not verified as hosted by this workspace. Remove only the artist from this channel manually; do not disconnect their organization.')
  }
  async function members(): Promise<string[]> {
    let cursor = ''; const ids: string[] = []
    for (let page=0;page<20;page++) {
      const result = object(await slack.apiCall('conversations.members',{channel,limit:200,...(cursor?{cursor}:{})}))
      if (!result.ok || !Array.isArray(result.members)) throw new Error('Slack membership unavailable')
      ids.push(...result.members.map(String))
      cursor = String(object(result.response_metadata).next_cursor || '')
      if (!cursor) return ids
    }
    throw new Error('Slack pagination incomplete')
  }
  let user = snapshot.engagement.artist_slack_id || snapshot.engagement.grants.slack?.subject
  if (!user) {
    let found: ObjectData
    try { found = object(await slack.apiCall('users.lookupByEmail',{email:snapshot.engagement.artist_email})) }
    catch (error) {
      if (object(object(error).data).error !== 'users_not_found') throw error
      found = {ok:false,error:'users_not_found'}
    }
    if (!found.ok && found.error !== 'users_not_found') throw new Error('Slack identity lookup unavailable')
    user = String(object(found.user).id || '')
    if (!user && connected) {
      // External people may not be in lookupByEmail. Never infer identity from names.
      const roster = await members(); const matches: string[] = []
      if (roster.length>200) return review('External Slack identity requires manual review in this large channel.')
      for (const id of roster) {
        const result = object(await slack.apiCall('users.info',{user:id}))
        if (!result.ok) throw new Error('Slack identity unavailable')
        if (identityEmail(String(object(object(result.user).profile).email || ''))===snapshot.engagement.artist_email) matches.push(id)
      }
      if (matches.length===1) user=matches[0]
    }
    if (!user) return review('Slack identity or pending invitation could not be verified. Resolve it in Slack.')
  }
  if (!/^[UW][A-Z0-9]+$/.test(user)) return review('Slack identity is ambiguous; no access changed.')
  const userInfo = object(await slack.apiCall('users.info',{user}))
  if (!userInfo.ok || identityEmail(String(object(object(userInfo.user).profile).email || '')) !== snapshot.engagement.artist_email) return review('Slack identity changed or email is unavailable; no access changed.')
  const externalArtist = connected && Boolean(object(userInfo.user).team_id) && object(userInfo.user).team_id !== localTeam
  if ((await members()).includes(user)) {
    await beforeWrite()
    const response = object(await slack.apiCall('conversations.kick',{channel,user}))
    if (!response.ok && response.error !== 'not_in_channel') throw new Error('Slack removal failed')
  }
  if ((await members()).includes(user)) return review('Artist is still a channel member.')
  if (!conversation.is_private && !externalArtist) return review('Channel membership removed, but this is a public channel. The artist may still browse or rejoin it; an admin must review channel privacy.')
  return removed('Project channel membership removed and verified. Direct canvas shares, saved history and public links are not recalled.')
}

export async function removeDropboxArtist(snapshot: OffboardSnapshot, beforeWrite: () => Promise<void>): Promise<StepResult> {
  const call = async (path: string, body: unknown) => json(await fetch(`https://api.dropboxapi.com/2${path}`,{method:'POST',headers:await dropboxHeaders(),body:JSON.stringify(body),signal:AbortSignal.timeout(15000)}))
  let folder = snapshot.engagement.grants.dropbox?.resource
  if (snapshot.dropboxPath) {
    const meta = await call('/files/get_metadata',{path:snapshot.dropboxPath,include_has_explicit_shared_members:true})
    const currentFolder = String(meta.shared_folder_id || object(meta.sharing_info).shared_folder_id || '')
    if (folder && folder!==currentFolder) return review('Recorded Dropbox grant differs from the current folder; reconcile it manually.')
    folder = currentFolder
  }
  if (!folder) return review('No verified shared-folder ID. Check project/parent-folder permissions; Kit will not share or delete folders during offboarding.')
  async function members() {
    let cursor = ''; const matches: ObjectData[] = []; let groups = false
    for (let page=0;page<20;page++) {
      const result = cursor ? await call('/sharing/list_folder_members/continue',{cursor}) : await call('/sharing/list_folder_members',{shared_folder_id:folder,limit:1000})
      groups ||= list(result.groups).length>0
      for (const member of [...list(result.users),...list(result.invitees)]) {
        const email = String(object(member.user).email || object(member.invitee).email || '')
        if (identityEmail(email)===snapshot.engagement.artist_email) matches.push(member)
      }
      cursor = String(result.cursor || '')
      if (!cursor) return {matches,groups}
    }
    throw new Error('Dropbox pagination incomplete')
  }
  const before = await members()
  if (before.matches.length>1 || before.matches.some(m=>m.is_inherited || object(m.access_type)['.tag']==='owner')) return review('Dropbox access is inherited, owner-level or ambiguous. Parent/group access was not changed.')
  if (before.matches.length) {
    await beforeWrite()
    const result = await call('/sharing/remove_folder_member',{shared_folder_id:folder,member:{'.tag':'email',email:snapshot.engagement.artist_email},leave_a_copy:false})
    if (result.async_job_id) {
      const job = await call('/sharing/check_job_status',{async_job_id:result.async_job_id})
      if (job['.tag']!=='complete') return review('Dropbox removal is still processing. Retry to verify membership; no files were deleted.')
    }
  }
  const after = await members()
  if (after.matches.length) return review('Dropbox still lists project membership or a pending invitation.')
  if (after.groups) return review('Direct folder membership removed. Group-based access remains possible and needs administrator review.')
  return removed('Direct project-folder membership/invitation removed and verified. Existing downloaded copies and shared links cannot be recalled.')
}

export async function removeFrameArtist(snapshot: OffboardSnapshot, beforeWrite: () => Promise<void>): Promise<StepResult> {
  const grant = snapshot.engagement.grants.frameio
  if ((grant?.resource && grant.resource!==snapshot.frameioProject) || (grant?.account && grant.account!==snapshot.frameioAccount)) return review('Recorded Frame.io grant differs from the current project/account; reconcile it manually.')
  const account = grant?.account || snapshot.frameioAccount
  const project = grant?.resource || snapshot.frameioProject
  if (!account || !project) return review('Frame.io project/account identity is missing; review project permissions manually.')
  const call = async (path: string, method='GET') => fetch(`https://api.frame.io/v4/accounts/${encodeURIComponent(account)}${path}`,{method,headers:await frameioHeaders(),signal:AbortSignal.timeout(15000)})
  const get = async (path:string)=>json(await call(path))
  const matches=(await frameUserRoles('/users',get)).filter(user=>user.email===snapshot.engagement.artist_email)
  if (matches.length!==1 || (grant?.subject && grant.subject!==matches[0].id)) return review('Frame.io identity is absent or ambiguous. Check pending account/project invitations manually.')
  const user=matches[0]
  if (!/^[a-zA-Z0-9@._:-]+$/.test(user.id)) return review('Frame.io identity is invalid; nothing changed.')
  if (user.role!=='member') return review('Frame.io account-level access is privileged or unknown; an administrator must review it. No global role was changed.')
  const projectPath=`/projects/${encodeURIComponent(project)}`
  const projectData=object((await get(projectPath)).data)
  if (!projectData.workspace_id) return review('Frame.io workspace identity is unavailable; nothing changed.')
  const inherited=(await frameUserRoles(`/workspaces/${encodeURIComponent(String(projectData.workspace_id))}/users`,get)).some(row=>row.id===user.id)
  const projectMembers=()=>frameUserRoles(`${projectPath}/users`,get)
  if ((await projectMembers()).some(row=>row.id===user.id)) {
    await beforeWrite()
    const response=await call(`${projectPath}/users/${encodeURIComponent(user.id)}`,'DELETE')
    // A 404 could be a bad route, not proof of absence.
    if (!response.ok) throw new Error('Frame.io removal not acknowledged')
  }
  if ((await projectMembers()).some(row=>row.id===user.id)) return review('Frame.io still lists project access. No global role or workspace membership was changed.')
  if (inherited) return review('Direct Frame.io project membership removed. Workspace access may still grant access; an administrator must review it without affecting other projects.')
  return removed('Frame.io project membership removed and verified; no workspace membership found. Account, media, comments and other projects retained. Review shared links separately.')
}

export function createArtistRemovalAdapters(slack: SlackApi) {
  return async (step: OffboardStep, snapshot: OffboardSnapshot, beforeWrite: () => Promise<void>): Promise<StepResult> => {
    const db = createAdminClient()
    const e = snapshot.engagement
    const {data:project,error} = await db.from('projects').select('id,external_links').eq('id',e.project_id).eq('workspace_id',e.workspace_id).maybeSingle()
    if (error || !project) throw new Error('Project identity unavailable')
    const links = object(project.external_links)
    if ((step==='slack' && snapshot.slackChannel && snapshot.slackChannel!==String(links.slack_id || links.slack_channel_id || '')) ||
        (step==='dropbox' && snapshot.dropboxPath && snapshot.dropboxPath!==String(links.dropbox_id || links.dropbox_path || '')) ||
        (step==='frameio' && snapshot.frameioProject && snapshot.frameioProject!==String(links.frameio_id || links.frameio_project_id || ''))) return review('Project resource changed since confirmation. Start a fresh review; no removal attempted.')
    switch(step) {
      case 'slack': return removeSlackArtist(slack,snapshot,beforeWrite)
      case 'dropbox': return removeDropboxArtist(snapshot,beforeWrite)
      case 'frameio': return removeFrameArtist(snapshot,beforeWrite)
      case 'harvest': return retained('Shared Freelancers bucket, historical hours and pending time confirmations retained. No Harvest seat/account was removed.')
      case 'kit_access': {
        const {data:people,error:lookupError} = await db.from('team_members').select('id,role,email,slack_user_id').eq('workspace_id',e.workspace_id)
        if (lookupError) throw new Error('Kit identity unavailable')
        const matches = (people || []).filter(p=>identityEmail(p.email || '')===e.artist_email)
        if (matches.length>1 || matches.some(p=>!['artist','freelancer'].includes(p.role))) return review('Kit identity is ambiguous or privileged. No account permissions changed.')
        if (matches.length) {
          await beforeWrite()
          const {error:removeError} = await db.from('project_access').delete().eq('workspace_id',e.workspace_id).eq('project_id',e.project_id).eq('team_member_id',matches[0].id)
          if (removeError) throw new Error('Kit access removal failed')
          const {data:remaining,error:verifyError} = await db.from('project_access').select('id').eq('workspace_id',e.workspace_id).eq('project_id',e.project_id).eq('team_member_id',matches[0].id)
          if (verifyError || remaining?.length) throw new Error('Kit access removal not verified')
        }
        return removed('Project-specific Kit dashboard grant removed. Person/staff identity, other projects and all history retained.')
      }
      case 'assignments': {
        const config = workbookConfigFromEnv()
        if (!config || !snapshot.projectNumber) return review('Project Control is not configured; review future assignments manually.')
        const {data:history,error:historyError} = await db.from('freelancer_onboardings').select('artist_name,artist_email').eq('project_id',e.project_id)
        if (historyError) throw new Error('Assignment identity unavailable')
        const key = (name: string) => name.trim().replace(/\s+/g,' ').toLowerCase()
        if ((history || []).some(p=>key(p.artist_name || '')===key(e.artist_name) && identityEmail(p.artist_email)!==e.artist_email)) return review('Another artist on this project has the same display name. Reassign rows manually; no names were guessed.')
        await beforeWrite()
        await recordArtistOffboardingInSheet(config,{engagementId:e.id,projectNumber:snapshot.projectNumber,person:e.artist_name,lastWorkingDate:snapshot.lastWorkingDate})
        return removed('Project-specific assignment exclusion recorded. Past rows and the shared People roster retained; future rows require reassignment. Canvas refresh uses the normal sync.')
      }
    }
  }
}
