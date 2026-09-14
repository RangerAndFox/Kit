import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {runOffboarding,type OffboardingPorts} from '../../src/lib/artist-access/workflow'
import {OFFBOARD_STEPS,type OffboardRequest,type OffboardSnapshot} from '../../src/lib/artist-access/types'
import {removeFrameArtist,removeSlackArtist,removeDropboxArtist} from '../../src/lib/artist-access/providers'
import {offboardingReview,offboardingOutcome,offboardingIdentity,projectPageRange,projectPageButtons,OFFBOARD_ACTION_PATTERN,latestArtistRoster} from '../src/offboarding/handlers'
import {commandActor} from '../src/handlers/natural-commands'
import {parseFastCommand} from '../src/handlers/command-catalog'
import {parseGuidanceCommand} from '../src/handlers/command-guidance'
vi.mock('../../src/lib/frameio/auth',()=>({frameioHeaders:async()=>({Authorization:'Bearer synthetic'})}))
vi.mock('../../src/lib/dropbox/client',()=>({dropboxHeaders:async()=>({Authorization:'Bearer synthetic'})}))
vi.mock('../src/handlers/natural-commands',async importOriginal=>({...await importOriginal<typeof import('../src/handlers/natural-commands')>(),commandActor:vi.fn()}))

const snapshot: OffboardSnapshot={engagement:{id:'e',workspace_id:'w',project_id:'p',artist_email:'artist@example.com',artist_name:'Artist Example',artist_slack_id:'UARTIST',state:'active',revision:1,grants:{},ended_at:null},projectName:'Synthetic project',projectNumber:'9991',slackChannel:'CPROJECT',dropboxPath:'/production/2099/9991_test',frameioProject:'frame-project',frameioAccount:'frame-account',assignmentsConfigured:true,lastWorkingDate:'2026-09-13'}
const request=():OffboardRequest=>({id:'r',workspace_id:'w',engagement_id:'e',actor:'UPRODUCER',snapshot:structuredClone(snapshot),status:'pending',results:{},expires_at:'2099-01-01'})
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}})
beforeEach(()=>vi.resetAllMocks())
afterEach(()=>vi.unstubAllGlobals())
it('runs each service once and skips successful steps on retry',async()=>{
 const input=request();const run=vi.fn(async()=>({status:'removed' as const,detail:'verified'}))
 const ports:OffboardingPorts={claim:async r=>({...r,status:'running'}),checkpoint:vi.fn(async()=>{}),run}
 input.results.harvest={status:'retained',detail:'shared bucket'}
 const result=await runOffboarding(input,ports)
 expect(run).toHaveBeenCalledTimes(5);expect(result.status).toBe('complete')
 await runOffboarding(result,ports);expect(run).toHaveBeenCalledTimes(5)
})
it('a provider outage remains partial while unrelated safe removals continue',async()=>{
 const result=await runOffboarding(request(),{claim:async r=>r,checkpoint:async()=>{},run:async step=>{if(step==='frameio')throw new Error('secret body');return {status:'removed',detail:'verified'}}})
 expect(result.status).toBe('partial');expect(JSON.stringify(result)).not.toContain('secret body');expect(result.results.slack?.status).toBe('removed')
})
it('a failed durable checkpoint stops before any subsequent provider writes',async()=>{
 const run=vi.fn(async()=>({status:'removed' as const,detail:'verified'}))
 await expect(runOffboarding(request(),{claim:async r=>r,checkpoint:async(_r,_o,step)=>{if(step)throw new Error('database offline')},run})).rejects.toThrow('database offline')
 expect(run).toHaveBeenCalledTimes(1)
})
it('denied/stale claim never reaches providers',async()=>{
 const run=vi.fn();await expect(runOffboarding(request(),{claim:async()=>{throw new Error('denied')},checkpoint:vi.fn(),run})).rejects.toThrow('denied');expect(run).not.toHaveBeenCalled()
})
it('preview identifies retention and offers Offboard/Edit/Cancel without posting',()=>{
 const blocks=JSON.stringify(offboardingReview(request()))
 for (const label of ['Offboard','Edit','Cancel','Harvest','other projects']) expect(blocks).toContain(label)
 expect(blocks).not.toContain('budget')
 const output=JSON.stringify(offboardingOutcome({...request(),status:'partial'}))
 expect(output).toContain('Retry failed steps');expect(output).not.toContain('Project memberships removed')
})
it.each(['Kit offboard Alex from project 2637','offboard an artist','Please remove artist Alex from 2637'])('routes %s only to private offboarding',text=>expect(parseFastCommand(text)?.command).toBe('offboard'))
it.each(['Do not offboard Alex','How do I offboard an artist?','"offboard Alex"'])('does not execute non-action text %s',text=>expect(parseFastCommand(text)).toBeNull())
it('guidance describes offboarding, not project deletion',()=>expect(parseGuidanceCommand('How do I remove an artist from a project?')).toBe('offboard'))
it('preserves literal project and person hints',()=>expect(parseFastCommand('remove Alex from project 2637')).toEqual({command:'offboard',args:'Alex from project 2637'}))
it('explains offboarding without starting it',()=>expect(parseGuidanceCommand('What is offboarding?')).toBe('offboard'))
it('pages large project rosters below Slack limits and rejects invalid page values',()=>{
 expect(projectPageRange(0)).toEqual([0,90]);expect(projectPageRange(2)).toEqual([180,270])
 for(const value of [-1,NaN,Infinity,1.5,1001])expect(()=>projectPageRange(value)).toThrow('Invalid')
})
it('uses the newest corrected identity when onboarding history contains retries',()=>{
 const latest={artist_email:'Artist@Example.com',artist_name:'Corrected Name'}
 expect(latestArtistRoster([latest,{artist_email:'artist@example.com',artist_name:'Old Guess'}])).toEqual([latest])
})
it.each([[0,true],[1,true],[2,false]] as const)('uses unique Slack action IDs on project page %i', (page,hasMore)=>{
 const buttons=projectPageButtons(page,hasMore)
 expect(new Set(buttons.map(b=>b.action_id)).size).toBe(buttons.length)
 for(const b of buttons)expect(OFFBOARD_ACTION_PATTERN.test(b.action_id)).toBe(true)
 expect(buttons.find(b=>b.text.text==='Previous projects')?.value).toBe(page>0?String(page-1):undefined)
 expect(buttons.find(b=>b.text.text==='More projects')?.value).toBe(hasMore?String(page+1):undefined)
 expect(buttons.at(-1)?.action_id).toBe('kit_offboard_dismiss')
 // Existing live cards remain usable after deployment.
 expect(OFFBOARD_ACTION_PATTERN.test('kit_offboard_page')).toBe(true)
})
it('artists cannot even open the offboarding DM',async()=>{
 vi.mocked(commandActor).mockResolvedValue({teamId:'TSTUDIO',user:{tier:'artist',workspaceId:'w'}} as Awaited<ReturnType<typeof commandActor>>)
 const client={conversations:{open:vi.fn()}} as unknown as Parameters<typeof offboardingIdentity>[0]
 await expect(offboardingIdentity(client,'UARTIST','TSTUDIO')).rejects.toThrow('producer/admin');expect(client.conversations.open).not.toHaveBeenCalled()
})
it('provider identity failure or non-DM target fails closed',async()=>{
 const open=vi.fn(async()=>({ok:true,channel:{id:'CPUBLIC'}}));const client={conversations:{open}} as unknown as Parameters<typeof offboardingIdentity>[0]
 vi.mocked(commandActor).mockRejectedValueOnce(new Error('workspace mismatch'))
 await expect(offboardingIdentity(client,'UPRODUCER','TOTHER')).rejects.toThrow('mismatch');expect(open).not.toHaveBeenCalled()
 vi.mocked(commandActor).mockResolvedValue({teamId:'TSTUDIO',user:{tier:'producer',workspaceId:'w'}} as Awaited<ReturnType<typeof commandActor>>)
 await expect(offboardingIdentity(client,'UPRODUCER','TSTUDIO')).rejects.toThrow('Private')
})

function slackFixture(options:{external?:boolean;private?:boolean;email?:string;stillMember?:boolean}={}) {
 let member=true;const methods:string[]=[]
 const apiCall=vi.fn(async(method:string)=>{
   methods.push(method)
   if(method==='conversations.info')return {ok:true,channel:{is_private:options.private!==false,is_ext_shared:options.external}}
   if(method==='users.info')return {ok:true,user:{profile:{email:options.email || 'artist@example.com'}}}
   if(method==='conversations.members')return {ok:true,members:member?['UARTIST']:[],response_metadata:{}}
   if(method==='conversations.kick'){if(!options.stillMember)member=false;return {ok:true}}
   throw new Error('unexpected method')
 });return {apiCall,methods}
}
it('Slack removes only the selected private-channel member and verifies absence',async()=>{
 const slack=slackFixture();const before=vi.fn(async()=>{});expect((await removeSlackArtist(slack,snapshot,before)).status).toBe('removed')
 expect(before).toHaveBeenCalledTimes(1);expect(slack.methods.filter(m=>m==='conversations.kick')).toHaveLength(1)
})
it.each([{external:true},{email:'someoneelse@example.com'}])('Slack holds unsafe identities/connections for review',async options=>{
 const slack=slackFixture(options);expect((await removeSlackArtist(slack,snapshot,async()=>{})).status).toBe('review');expect(slack.methods).not.toContain('conversations.kick')
})
it.each([{private:false},{stillMember:true}])('Slack does not claim effective removal for public or retained membership',async options=>expect((await removeSlackArtist(slackFixture(options),snapshot,async()=>{})).status).toBe('review'))

function frameFixture(options:{inherited?:boolean;admin?:boolean;deleted?:boolean;failDelete?:boolean;stillMember?:boolean}={}) {
 let present=!options.deleted;const writes:string[]=[]
 const user={id:'11111111-1111-4111-8111-111111111111',email:'artist@example.com'}
 vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{
  const url=new URL(input)
  if(init?.method==='DELETE'){writes.push(url.pathname);if(options.failDelete)return json({},404);if(!options.stillMember)present=false;return new Response(null,{status:204})}
  if(url.pathname.endsWith('/accounts/frame-account/users'))return json({data:[{user,role:options.admin?'admin':'member'}],links:{}})
  if(url.pathname.endsWith('/projects/frame-project'))return json({data:{id:'frame-project',workspace_id:'workspace'}})
  if(url.pathname.includes('/workspaces/workspace/users'))return json({data:options.inherited?[{user,role:'editor'}]:[],links:{}})
  if(url.pathname.endsWith('/projects/frame-project/users'))return json({data:present?[{user,role:'editor'}]:[],links:{}})
  throw new Error('Unexpected URL')
 }));return writes
}
it('Frame.io verifies removal using both project and workspace permissions',async()=>{
 const writes=frameFixture();expect((await removeFrameArtist(snapshot,async()=>{})).status).toBe('removed');expect(writes).toHaveLength(1);expect(writes[0]).toContain('/projects/frame-project/users/')
})
it('Frame.io no-op retries verify absence without another delete',async()=>{
 const writes=frameFixture({deleted:true});expect((await removeFrameArtist(snapshot,async()=>{})).status).toBe('removed');expect(writes).toHaveLength(0)
})
it.each([{inherited:true},{admin:true},{stillMember:true}])('Frame.io flags inherited/admin/still-present access',async options=>{frameFixture(options);expect((await removeFrameArtist(snapshot,async()=>{})).status).toBe('review')})
it('Frame.io 404 is not accepted as proof of revocation',async()=>{frameFixture({failDelete:true});await expect(removeFrameArtist(snapshot,async()=>{})).rejects.toThrow()})
it('Dropbox removes only an explicit folder membership and verifies it',async()=>{
 let member=true;const writes:Array<Record<string,unknown>>=[]
 vi.stubGlobal('fetch',vi.fn(async(input:string,init:RequestInit)=>{
  if(input.endsWith('/files/get_metadata'))return json({shared_folder_id:'folder-id'})
  if(input.endsWith('/sharing/list_folder_members'))return json({users:member?[{user:{email:'artist@example.com'},access_type:{'.tag':'editor'},is_inherited:false}]:[],invitees:[],groups:[]})
  if(input.endsWith('/sharing/remove_folder_member')){writes.push(JSON.parse(String(init.body)));member=false;return json({'.tag':'complete'})}
  throw new Error('Unexpected endpoint')
 }))
 expect((await removeDropboxArtist(snapshot,async()=>{})).status).toBe('removed')
 expect(writes).toEqual([{shared_folder_id:'folder-id',member:{'.tag':'email',email:'artist@example.com'},leave_a_copy:false}])
})
it('Dropbox inherited access never removes a parent/group membership',async()=>{
 let writes=0
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>{
  if(input.endsWith('/files/get_metadata'))return json({shared_folder_id:'folder-id'})
  if(input.endsWith('/sharing/list_folder_members'))return json({users:[{user:{email:'artist@example.com'},is_inherited:true}],invitees:[],groups:[]})
  writes++;throw new Error('forbidden write')
 }))
 expect((await removeDropboxArtist(snapshot,async()=>{})).status).toBe('review');expect(writes).toBe(0)
})
it('every step is accounted for including preserved Harvest',()=>expect(OFFBOARD_STEPS).toEqual(['slack','dropbox','frameio','kit_access','assignments','harvest']))
