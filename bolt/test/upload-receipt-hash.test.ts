import { beforeEach, expect, it, vi } from 'vitest'
import type { RenameMetadata, UploadApproval } from '../../src/lib/delivery/upload-approval'
const rpc=vi.hoisted(()=>vi.fn())
vi.mock('../../src/lib/supabase/admin',()=>({createAdminClient:()=>({rpc})}))
import { completedUploadReceipt } from '../../src/lib/delivery/upload-approval-store'
const receipt={id:'receipt',workspace_id:'workspace',project_id:'project',source_file_id:'id:old',source_rev:'abcdef12345',source_size:100,state:'complete',frame_file_id:'frame'} as UploadApproval
const source={path:'/original.mp4',name:'original.mp4',safeName:'project',year:'2026',subfolder:'01_Client Progress',dropboxId:'id:new',rev:'abcdef54321',content_hash:'a'.repeat(64)}
const metadata:RenameMetadata={id:receipt.source_file_id,rev:receipt.source_rev,size:100,path_display:'/renamed.mp4',content_hash:'a'.repeat(64)}
let saved:boolean
beforeEach(()=>{
  saved=false;rpc.mockReset()
  rpc.mockImplementation(async(name:string)=>({error:null,data:name==='find_completed_frame_upload_receipt'?(saved?receipt:null):name==='find_unhashed_frame_upload_receipt'?receipt:name==='save_frame_upload_receipt_hash'?(saved=true):null}))
})
it('recovers a legacy hash only from the exact historical file ID/revision/size, then reruns the strict lookup',async()=>{
  const load=vi.fn().mockResolvedValue(metadata)
  expect(await completedUploadReceipt('project',source,100,load)).toEqual(receipt)
  expect(load).toHaveBeenCalledWith(`rev:${receipt.source_rev}`)
  expect(rpc).toHaveBeenCalledWith('save_frame_upload_receipt_hash',expect.objectContaining({p_id:'receipt',p_workspace:'workspace',p_file:'id:old',p_rev:'abcdef12345',p_size:100,p_hash:source.content_hash}))
  expect(rpc.mock.calls.filter(([name])=>name==='find_completed_frame_upload_receipt')).toHaveLength(2)
})
it.each([{id:'id:new'},{rev:'abcdef99999'},{size:101},{content_hash:undefined},{content_hash:'not-a-hash'}])('refuses missing or mismatched historical proof %j',async(change)=>{
  expect(await completedUploadReceipt('project',source,100,async()=>({...metadata,...change}))).toBeNull()
  expect(rpc.mock.calls.some(([name])=>name==='save_frame_upload_receipt_hash')).toBe(false)
})
it('keeps unavailable historical metadata unresolved instead of assuming duplicate bytes',async()=>{
  expect(await completedUploadReceipt('project',source,100,async()=>{throw new Error('not_found')})).toBeNull()
  expect(saved).toBe(false)
})
it('does not treat a stored proof or same-size candidate as an exact-byte match',async()=>{
  rpc.mockImplementation(async(name:string)=>({error:null,data:name==='find_unhashed_frame_upload_receipt'?receipt:name==='save_frame_upload_receipt_hash'?true:null}))
  expect(await completedUploadReceipt('project',source,100,async()=>({...metadata,content_hash:'b'.repeat(64)}))).toBeNull()
})
it('uses an existing strict receipt without making another provider request',async()=>{
  saved=true;const load=vi.fn()
  expect(await completedUploadReceipt('project',source,100,load)).toEqual(receipt)
  expect(load).not.toHaveBeenCalled()
})
