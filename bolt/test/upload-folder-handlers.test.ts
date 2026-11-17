import { beforeEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
import type { FolderContext } from '../../src/lib/delivery/upload-folder'
import type { UploadApproval } from '../../src/lib/delivery/upload-approval'
const mocks=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn(),prepare:vi.fn(),authorize:vi.fn(),source:vi.fn(),sync:vi.fn()}))
vi.mock('../../src/lib/supabase/admin',()=>({createAdminClient:()=>({from:mocks.from})}))
vi.mock('../../src/lib/delivery/upload-folder-store',()=>({folderRpc:mocks.rpc,prepareUploadFolder:mocks.prepare}))
vi.mock('../../src/lib/delivery/upload-approval-store',()=>({assertUploadReviewer:mocks.authorize}))
vi.mock('../src/watchers/dropbox',()=>({verifyApprovalSource:mocks.source}))
vi.mock('../src/watchers/upload-folder-notices',()=>({syncUploadFolderNotices:mocks.sync}))
import { registerUploadFolderHandlers } from '../src/watchers/upload-folder-handlers'
const handlers=new Map<string,(p:Record<string,unknown>)=>Promise<void>>()
const client={views:{open:vi.fn(),update:vi.fn()},chat:{postMessage:vi.fn()}}
let context:FolderContext
beforeEach(()=>{
  vi.resetAllMocks();handlers.clear()
  context={folder:{id:'folder',workspace_id:'workspace',project_id:'project',folder_path:'/production/2026/2646_Microsoft_Foundry/09_outgoing/02_delivery/111726',generation:2,manifest:[],slack_channel_id:null,slack_message_ts:null},files:['ttml','vtt','txt'].map((ext,i)=>({id:`file${i}`,state:'awaiting',source_path:`${ext}/captions.${ext}`} as UploadApproval)),dirty:[],legacy:[],slots:[]}
  mocks.prepare.mockResolvedValue(context);mocks.authorize.mockResolvedValue(undefined);mocks.source.mockResolvedValue(true);mocks.rpc.mockResolvedValue(true)
  mocks.from.mockImplementation((table:string)=>{
    const q={select:()=>q,eq:()=>q,single:async()=>({data:table==='frame_upload_folder_reviews'?context.folder:{id:'workspace'},error:null})};return q
  })
  const register=(id:unknown,fn:unknown)=>{if(typeof id==='string')handlers.set(id,fn as (p:Record<string,unknown>)=>Promise<void>);else if(id instanceof RegExp)handlers.set('folder_action',fn as (p:Record<string,unknown>)=>Promise<void>)}
  registerUploadFolderHandlers({action:register,view:register,client} as unknown as App)
})
const input={id:'folder',generation:2,base:'R&F_Microsoft_Foundry',date:'111726'}
it('a failed modal open reports the error privately rather than silently doing nothing',async()=>{
  client.views.open.mockRejectedValue(new Error('Slack trigger expired'))
  const ack=vi.fn()
  await handlers.get('folder_action')!({ack,body:{trigger_id:'trigger',team:{id:'TTEAM'},user:{id:'UPRODUCER'}},action:{action_id:'kit_frame_folder_review',value:JSON.stringify(input)},client})
  expect(ack).toHaveBeenCalledOnce()
  expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({channel:'UPRODUCER',text:expect.stringContaining('trigger expired')}))
  expect(mocks.rpc).not.toHaveBeenCalled()
})
async function confirm(extra:Record<string,unknown>={}) {
  await handlers.get('kit_frame_folder_confirm')!({ack:vi.fn(),body:{team:{id:'TTEAM'},user:{id:'UPRODUCER'}},view:{id:'view',private_metadata:JSON.stringify({...input,...extra})},client})
}
it('verifies every source then queues the complete exact manifest with the authenticated actor',async()=>{
  await confirm()
  expect(mocks.source).toHaveBeenCalledTimes(3)
  expect(mocks.rpc).toHaveBeenCalledWith('decide_frame_upload_folder',expect.objectContaining({p_actor:'UPRODUCER',p_workspace:'workspace',p_generation:2,p_cancel:false,p_names:expect.arrayContaining([{id:'file0',name:'R&F_Microsoft_Foundry_TTML_111726.ttml'}])}))
})
it('Cancel upload skips pending files with no provider reads',async()=>{
  await confirm({cancel:true})
  expect(mocks.source).not.toHaveBeenCalled()
  expect(mocks.rpc).toHaveBeenCalledWith('decide_frame_upload_folder',expect.objectContaining({p_cancel:true,p_names:[]}))
})
it('a changed member invalidates the entire approval, not just that file',async()=>{
  mocks.source.mockResolvedValueOnce(false)
  await confirm()
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(JSON.stringify(client.views.update.mock.calls)).toContain('nothing new was approved')
})
it('stale forms, unauthorized actors, and cross-workspace requests fail before provider access',async()=>{
  context.folder.generation=3;await confirm()
  expect(mocks.source).not.toHaveBeenCalled();expect(mocks.rpc).not.toHaveBeenCalled()
  context.folder.generation=2;mocks.authorize.mockRejectedValue(new Error('not a reviewer'));await confirm()
  expect(mocks.source).not.toHaveBeenCalled();expect(mocks.rpc).not.toHaveBeenCalled()
  context.folder.workspace_id='other';mocks.authorize.mockReset();await confirm()
  expect(mocks.authorize).not.toHaveBeenCalled();expect(mocks.rpc).not.toHaveBeenCalled()
})
it('a losing concurrent confirmation does not refresh or claim success',async()=>{
  mocks.rpc.mockResolvedValue(false);await confirm()
  expect(mocks.sync).not.toHaveBeenCalled()
  expect(JSON.stringify(client.views.update.mock.calls)).toContain('Another reviewer decided this folder')
})
