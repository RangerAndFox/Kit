import { beforeEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
import type { FolderContext } from '../../src/lib/delivery/upload-folder'
import type { UploadApproval } from '../../src/lib/delivery/upload-approval'
const mocks=vi.hoisted(()=>({rpc:vi.fn(),prepare:vi.fn(),from:vi.fn(),get:vi.fn(),deliver:vi.fn(),open:vi.fn(),update:vi.fn()}))
vi.mock('../../src/lib/delivery/upload-folder-store',()=>({folderRpc:mocks.rpc,prepareUploadFolder:mocks.prepare}))
vi.mock('../../src/lib/supabase/admin',()=>({createAdminClient:()=>({from:mocks.from})}))
vi.mock('../../src/lib/delivery/upload-approval-store',()=>({getUploadApproval:mocks.get}))
vi.mock('../../src/lib/slack/durable-delivery',()=>({deliverSlackOnce:mocks.deliver}))
import { syncUploadFolderNotices } from '../src/watchers/upload-folder-notices'
import { uploadFolderCard } from '../src/watchers/upload-folder-card'
let context:FolderContext
const app={client:{conversations:{open:mocks.open},chat:{update:mocks.update}}} as unknown as App
beforeEach(()=>{
  vi.resetAllMocks()
  context={folder:{id:'folder',workspace_id:'workspace',project_id:'project',folder_path:'/production/2026/2646_Microsoft_Foundry/09_outgoing/02_delivery/111726',generation:3,manifest:[],slack_channel_id:null,slack_message_ts:null},
    files:['ttml','vtt','txt'].map((ext,i)=>({id:`file${i}`,project_id:'project',workspace_id:'workspace',state:'awaiting',source_path:`/production/2026/2646_Microsoft_Foundry/09_outgoing/02_delivery/111726/accessibility/captions.${ext}`,approval_version:1} as UploadApproval)),
    slots:['100.1','100.2','100.3'].map((ts,i)=>({id:`slot${i}`,slack_channel_id:'GSHARED',slack_message_ts:ts,folder_notice_closed:false})),dirty:[],legacy:[]}
  mocks.prepare.mockImplementation(async()=>context)
  mocks.rpc.mockImplementation(async(name:string)=>name==='list_frame_upload_folder_notices'?[{project_id:'project',folder_path:context.folder.folder_path}]:true)
  mocks.open.mockImplementation(async({users}:{users:string})=>({channel:{id:users==='UPRODUCER'?'DPRODUCER':'GSHARED'}}))
  mocks.deliver.mockResolvedValue('200.1');mocks.update.mockResolvedValue({ok:true})
  mocks.get.mockImplementation(async(id:string)=>context.files.find(f=>f.id===id))
  mocks.from.mockImplementation(()=>{
    const q={select:()=>q,eq:()=>q,update:()=>q,single:async()=>({data:{project_manager_slack_id:'UPRODUCER',external_ids:{creative_director_slack_id:'UCD'},project_code:'2646',name:'Foundry',client:'Microsoft'},error:null}),then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({error:null}).then(resolve)}
    return q
  })
})
it('posts one concise folder request for TTML/VTT/TXT and closes old per-file controls in place',async()=>{
  await syncUploadFolderNotices(app)
  expect(mocks.deliver).toHaveBeenCalledTimes(1)
  const card=mocks.deliver.mock.calls[0][0]
  expect(card.key).toBe('frame-upload-folder:folder')
  expect(JSON.stringify(card)).toContain('UPLOAD TO FRAME');expect(JSON.stringify(card)).toContain('CANCEL UPLOAD')
  expect(JSON.stringify(card)).toContain('|Dropbox>')
  expect(JSON.stringify(card)).not.toContain('Review & upload')
  expect(mocks.update).toHaveBeenCalledTimes(3)
  for(const [copy] of mocks.update.mock.calls) expect(copy.blocks.some((b:{type:string})=>b.type==='actions')).toBe(false)
  expect(mocks.rpc).toHaveBeenCalledWith('finish_frame_upload_folder_notice',expect.objectContaining({p_success:true,p_generation:3}))
})
it('later file arrivals update the same folder card quietly rather than posting new messages',async()=>{
  context.folder.slack_channel_id='GSHARED';context.folder.slack_message_ts='200.1';context.slots=[]
  await syncUploadFolderNotices(app);await syncUploadFolderNotices(app)
  expect(mocks.deliver).not.toHaveBeenCalled();expect(mocks.update).toHaveBeenCalledTimes(2)
  expect(mocks.update.mock.calls[0][0].ts).toBe('200.1')
})
it('a competing folder sender lease cannot write Slack',async()=>{
  mocks.rpc.mockImplementation(async(name:string)=>name==='list_frame_upload_folder_notices'?[{project_id:'project',folder_path:context.folder.folder_path}]:false)
  await syncUploadFolderNotices(app)
  expect(mocks.deliver).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled()
})
it('unknown Slack outcomes keep the same durable folder key on retry',async()=>{
  mocks.deliver.mockRejectedValue(new Error('unknown outcome'))
  await syncUploadFolderNotices(app);await syncUploadFolderNotices(app)
  expect(mocks.deliver).toHaveBeenCalledTimes(2)
  for(const [args] of mocks.deliver.mock.calls) expect(args.key).toBe('frame-upload-folder:folder')
  expect(mocks.rpc).toHaveBeenCalledWith('finish_frame_upload_folder_notice',expect.objectContaining({p_success:false}))
})
it('does not send a private folder to changed recipients',async()=>{
  mocks.open.mockResolvedValue({channel:{id:'GOTHER'}})
  await syncUploadFolderNotices(app)
  expect(mocks.deliver).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled()
})
it('same-name collision prompts still go only to the original approver',async()=>{
  const row=context.files[0];row.state='collision';row.approved_by='UPRODUCER';row.approved_name='R&F_Microsoft_Foundry_TTML_111726.ttml'
  context.dirty=[{id:row.id,updated_at:'now'}]
  await syncUploadFolderNotices(app)
  expect(mocks.deliver).toHaveBeenCalledWith(expect.objectContaining({key:'frame-upload-collision:file0',channel:'DPRODUCER'}))
  context.files.forEach(f=>f.state='complete')
  expect(uploadFolderCard(context,'2646','R&F_Microsoft_Foundry','111726').blocks.some(b=>b.type==='actions')).toBe(false)
})
it('an inaccessible old individual card cannot block the approver’s real collision decision',async()=>{
  const row=context.files[0];row.state='collision';row.approved_by='UPRODUCER';row.approved_name='R&F_Microsoft_Foundry_TTML_111726.ttml'
  context.dirty=[{id:row.id,updated_at:'now'}]
  mocks.update.mockRejectedValueOnce(new Error('Old card inaccessible'))
  await syncUploadFolderNotices(app)
  expect(mocks.deliver).toHaveBeenCalledWith(expect.objectContaining({key:'frame-upload-collision:file0',channel:'DPRODUCER'}))
  expect(mocks.rpc).toHaveBeenCalledWith('finish_frame_upload_folder_notice',expect.objectContaining({p_success:false}))
})
