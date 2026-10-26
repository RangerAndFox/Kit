import { beforeEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
import type { UploadApproval } from '../../src/lib/delivery/upload-approval'
const mocks = vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn(),get:vi.fn(),source:vi.fn(),conflicts:vi.fn(),authorize:vi.fn()}))
vi.mock('../../src/lib/supabase/admin',()=>({createAdminClient:()=>({from:mocks.from,rpc:mocks.rpc})}))
vi.mock('../../src/lib/delivery/upload-approval-store',()=>({uploadApprovalsEnabled:()=>true,getUploadApproval:mocks.get,assertUploadReviewer:mocks.authorize}))
vi.mock('../src/watchers/dropbox',()=>({verifyApprovalSource:mocks.source,uploadApprovalConflicts:mocks.conflicts}))
vi.mock('../../src/lib/slack/durable-delivery',()=>({deliverSlackOnce:vi.fn()}))
import { registerUploadApprovalHandlers, reviewModal } from '../src/watchers/upload-approval-handlers'
const name='R&F_Client_Project_Edit_V1.mov'
let row: UploadApproval
const handlers=new Map<string,(payload:Record<string,unknown>)=>Promise<void>>()
const client={views:{update:vi.fn(),open:vi.fn()},chat:{postMessage:vi.fn()}}
beforeEach(()=>{
  vi.clearAllMocks(); handlers.clear()
  row={id:'request',workspace_id:'workspace',project_id:'project',state:'awaiting',source_path:'/test.mov',suggested_name:name,
    approved_name:name,approved_by:'UPRODUCER',approval_version:1,
    source_payload:{safeName:'2645_Microsoft_Cloud_PC',subfolder:'01_Client Progress',name:'102326_Edit_V3/test.mov'}} as UploadApproval
  mocks.get.mockImplementation(async()=>({...row}))
  mocks.rpc.mockResolvedValue({data:true,error:null})
  mocks.source.mockResolvedValue(true)
  mocks.authorize.mockResolvedValue(undefined)
  mocks.conflicts.mockResolvedValue([{id:'existing',name,type:'file'}])
  mocks.from.mockImplementation(()=>{
    const query={select:()=>query,eq:()=>query,is:()=>query,in:()=>query,order:()=>query,limit:()=>query,
      single:async()=>({data:{id:'workspace'},error:null}),then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:[],error:null}).then(resolve)}
    return query
  })
  const register=(id:unknown,fn:unknown)=>{if(typeof id==='string'&&typeof fn==='function') handlers.set(id,fn as (payload:Record<string,unknown>)=>Promise<void>)}
  registerUploadApprovalHandlers({action:register,view:register,client} as unknown as App)
})
function invoke(id:string,metadata:unknown,values:Record<string,unknown>={},user='UPRODUCER') {
  return handlers.get(id)!({ack:vi.fn().mockResolvedValue(undefined),client,body:{team:{id:'TTEAM'},user:{id:user}},
    view:{id:'view',private_metadata:typeof metadata==='string'?metadata:JSON.stringify(metadata),state:{values}}})
}
it('initial review has a prefilled name, no readiness checkbox or duplicate preference',()=>{
  const modal=reviewModal(row)
  expect(modal.submit?.text).toBe('Upload')
  expect(modal.blocks.some(b=>'block_id' in b&&['ready','collision'].includes(b.block_id || ''))).toBe(false)
  expect(JSON.stringify(modal)).toContain(name)
  expect(JSON.stringify(reviewModal({...row,suggested_name:'R&F_Client_Project_Phase_Version.mov'}))).not.toContain('Phase_Version')
})
it('previews the exact name and mirrored destination without requiring phase or a rendering checkbox',async()=>{
  expect(reviewModal(row).blocks.some(b=>'block_id' in b&&b.block_id==='collision')).toBe(false)
  const simpleName='R&F_Client_Project.mov'
  await invoke('kit_frame_upload_submit','request',{filename:{value:{value:simpleName}}})
  expect(mocks.conflicts).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
  const modal=client.views.update.mock.calls[0][0].view
  expect(JSON.parse(modal.private_metadata)).toEqual({id:'request',name:simpleName,decision:'new'})
  expect(modal.submit.text).toBe('Confirm')
  expect(JSON.stringify(modal.blocks)).toContain('2645_Microsoft_Cloud_PC / 03_Outgoing / 01_Client Progress / 102326_Edit_V3')
  expect(JSON.stringify(modal.blocks)).toContain('Go back')
})
it('goes back to the editable name without approving or querying Frame',async()=>{
  const editedName='R&F_Client_Project_Edited.mov'
  await handlers.get('kit_frame_upload_back')!({ack:vi.fn(),client,
    body:{team:{id:'TTEAM'},user:{id:'UPRODUCER'},view:{id:'view',private_metadata:JSON.stringify({id:'request',name:editedName,decision:'new'})}}})
  const modal=client.views.update.mock.calls[0][0].view
  expect(modal.callback_id).toBe('kit_frame_upload_submit')
  expect(JSON.stringify(modal.blocks)).toContain(editedName)
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.source).not.toHaveBeenCalled()
  expect(mocks.conflicts).not.toHaveBeenCalled()
})
it('keeps an invalid edited name in the form for correction without starting an upload',async()=>{
  await invoke('kit_frame_upload_submit','request',{filename:{value:{value:'../wrong.exe'}}})
  const modal=client.views.update.mock.calls[0][0].view
  expect(modal.callback_id).toBe('kit_frame_upload_submit')
  expect(JSON.stringify(modal.blocks)).toContain('../wrong.exe')
  expect(JSON.stringify(modal.blocks)).not.toContain('Close and reopen')
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.source).not.toHaveBeenCalled()
})
it('Go back cannot reopen an approval already decided by another reviewer',async()=>{
  row.state='approved'
  await handlers.get('kit_frame_upload_back')!({ack:vi.fn(),client,
    body:{team:{id:'TTEAM'},user:{id:'UCD'},view:{id:'view',private_metadata:JSON.stringify({id:'request',name,decision:'new'})}}})
  expect(JSON.stringify(client.views.update.mock.calls)).not.toContain('kit_frame_upload_submit')
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('rejects workspace or reviewer mismatches before showing confirmation',async()=>{
  mocks.authorize.mockRejectedValue(new Error('Not a project reviewer'))
  await invoke('kit_frame_upload_submit','request',{filename:{value:{value:name}}},'UARTIST')
  expect(JSON.stringify(client.views.update.mock.calls)).not.toContain('kit_frame_upload_confirm')
  expect(mocks.source).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('rejects another workspace before reviewer checks or provider access',async()=>{
  row.workspace_id='other-workspace'
  await invoke('kit_frame_upload_submit','request',{filename:{value:{value:name}}})
  expect(mocks.authorize).not.toHaveBeenCalled()
  expect(mocks.source).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(JSON.stringify(client.views.update.mock.calls)).toContain('another workspace')
})
it('final initial approval locks the authenticated reviewer with a new-only decision',async()=>{
  await invoke('kit_frame_upload_confirm',{id:'request',name,decision:'new'})
  expect(mocks.rpc).toHaveBeenCalledWith('decide_frame_upload',expect.objectContaining({p_actor:'UPRODUCER',p_name:name,p_decision:'new'}))
})
it('an old upfront replacement form cannot bypass the conditional duplicate prompt',async()=>{
  await invoke('kit_frame_upload_confirm',{id:'request',name,decision:'replace',conflict:{id:'existing',type:'file'}})
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(client.chat.postMessage.mock.calls[0][0].text).toContain('outdated')
})
it('previews the numbered name only after an actual collision',async()=>{
  row.state='collision'
  await invoke('kit_frame_collision_choose',{id:'request',version:1},{collision:{value:{selected_option:{value:'keep_both'}}}})
  expect(JSON.parse(client.views.update.mock.calls[0][0].view.private_metadata)).toEqual({id:'request',name:'R&F_Client_Project_Edit_V1_02.mov',decision:'keep_both',collisionVersion:1})
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('rejects another reviewer before any collision provider read or decision',async()=>{
  row.state='collision'
  await invoke('kit_frame_collision_choose',{id:'request',version:1},{collision:{value:{selected_option:{value:'replace'}}}},'UCD')
  expect(mocks.conflicts).not.toHaveBeenCalled()
  await invoke('kit_frame_upload_confirm',{id:'request',name,decision:'skip',collisionVersion:1},{},'UCD')
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(client.chat.postMessage.mock.calls[0][0].text).toContain('Only the person')
})
it('collision Skip needs no provider call and uses the owner/version-fenced RPC',async()=>{
  row.state='collision'
  await invoke('kit_frame_upload_confirm',{id:'request',name,decision:'skip',collisionVersion:1})
  expect(mocks.source).not.toHaveBeenCalled()
  expect(mocks.conflicts).not.toHaveBeenCalled()
  expect(mocks.rpc).toHaveBeenCalledWith('resolve_frame_upload_collision',expect.objectContaining({p_actor:'UPRODUCER',p_version:1,p_decision:'skip'}))
})
it('a provider outage leaves the collision paused without choosing a fallback',async()=>{
  row.state='collision'; mocks.conflicts.mockRejectedValue(new Error('Frame unavailable'))
  await invoke('kit_frame_collision_choose',{id:'request',version:1},{collision:{value:{selected_option:{value:'replace'}}}})
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(JSON.stringify(client.views.update.mock.calls)).toContain('Frame unavailable')
})
it('refuses stale collision forms',async()=>{
  row.state='collision'; row.approval_version=2
  await invoke('kit_frame_upload_confirm',{id:'request',name,decision:'replace',collisionVersion:1})
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.source).not.toHaveBeenCalled()
})
