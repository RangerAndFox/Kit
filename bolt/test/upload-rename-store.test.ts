import { beforeEach, expect, it, vi } from 'vitest'
import type { UploadApproval } from '../../src/lib/delivery/upload-approval'
import { buildUploadRenameIntent } from '../../src/lib/delivery/upload-approval'
const mocks=vi.hoisted(()=>({from:vi.fn()}))
vi.mock('../../src/lib/supabase/admin',()=>({createAdminClient:()=>({from:mocks.from})}))
import { hasApprovedRename, recordUploadRenameIntent } from '../../src/lib/delivery/upload-approval-store'

const row={id:'request',workspace_id:'workspace',project_id:'project',state:'approved',source_file_id:'id:file',
  source_rev:'abcdef12345',source_size:12,source_path:'/project/video.mov',approved_name:'R&F_Client_Project.mov',
  approved_by:'UPRODUCER',approval_version:1,source_payload:{path:'/project/video.mov'}} as UploadApproval
const before={id:row.source_file_id,rev:row.source_rev,size:12,path_display:row.source_path,content_hash:'a'.repeat(64)}
const renamed={...before,rev:'abcdef54321',path_display:'/project/R&F_Client_Project.mov'}
let result: {data:unknown;error:unknown}
let calls: unknown[][]
beforeEach(()=>{
  calls=[]; result={data:{id:'request'},error:null}; vi.clearAllMocks()
  mocks.from.mockImplementation((table:string)=>{
    calls.push(['from',table])
    const query={then:(resolve:(v:unknown)=>unknown)=>Promise.resolve(result).then(resolve)} as Record<string,unknown>
    for(const method of ['select','update','eq','is','in','contains','limit','maybeSingle']) query[method]=(...args:unknown[])=>{calls.push([method,...args]);return query}
    return query
  })
})
it('persists intent before rename with workspace, decision-generation and no-POST fences',async()=>{
  const recorded=await recordUploadRenameIntent(row,before)
  expect(recorded.source_rev).toBe(row.source_rev)
  expect(recorded.source_payload).toMatchObject({path:row.source_path,rename_intent:{content_hash:before.content_hash,target_path:renamed.path_display.toLowerCase()}})
  for(const filter of [['eq','id','request'],['eq','workspace_id','workspace'],['eq','state','approved'],['eq','approval_version',1],['is','upload_attempted_at',null]]) expect(calls).toContainEqual(filter)
})
it('refuses any source change or missing hash before writing intent',async()=>{
  await expect(recordUploadRenameIntent(row,{...before,content_hash:undefined})).rejects.toThrow(/verify/)
  await expect(recordUploadRenameIntent(row,{...before,rev:'abcdef99999'})).rejects.toThrow(/verify/)
  expect(mocks.from).not.toHaveBeenCalled()
})
it('a lost decision or database error prevents the move boundary',async()=>{
  result={data:null,error:null}
  await expect(recordUploadRenameIntent(row,before)).rejects.toThrow(/ownership/)
  result={data:null,error:{message:'unavailable'}}
  await expect(recordUploadRenameIntent(row,before)).rejects.toThrow(/checkpoint/)
})
it('finds only an exact content/path rename using a bounded project/file lookup',async()=>{
  result={data:[{...row,source_payload:{rename_intent:buildUploadRenameIntent(row,before)}}],error:null}
  expect(await hasApprovedRename('project',renamed)).toBe(true)
  expect(calls).toContainEqual(['eq','project_id','project'])
  expect(calls).toContainEqual(['eq','source_file_id','id:file'])
  expect(calls).toContainEqual(['contains','source_payload',{rename_intent:{target_path:renamed.path_display.toLowerCase(),content_hash:before.content_hash}}])
  expect(calls).toContainEqual(['limit',2])
  expect(await hasApprovedRename('project',{...renamed,content_hash:'b'.repeat(64)})).toBe(false)
  expect(await hasApprovedRename('project',{...renamed,path_display:'/project/other.mov'})).toBe(false)
})
it('unknown database outcomes cannot silently drop a detection event',async()=>{
  result={data:null,error:{message:'unavailable'}}
  await expect(hasApprovedRename('project',renamed)).rejects.toThrow(/verify previous/)
})
