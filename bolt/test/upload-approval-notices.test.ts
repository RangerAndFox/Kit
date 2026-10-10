import { afterEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const mocks = vi.hoisted(() => ({ from:vi.fn(), rpc:vi.fn(), get:vi.fn(), update:vi.fn() }))
vi.mock('../../src/lib/supabase/admin',()=>({createAdminClient:()=>({from:mocks.from,rpc:mocks.rpc})}))
vi.mock('../../src/lib/delivery/upload-approval-store',()=>({uploadApprovalsEnabled:()=>true,getUploadApproval:mocks.get,assertUploadReviewer:vi.fn()}))
vi.mock('../src/watchers/dropbox',()=>({uploadApprovalConflicts:vi.fn(),verifyApprovalSource:vi.fn()}))
vi.mock('../../src/lib/slack/durable-delivery',()=>({deliverSlackOnce:vi.fn()}))
import { syncUploadApprovalNotices } from '../src/watchers/upload-approval-handlers'
afterEach(()=>vi.restoreAllMocks())

it('one failed card does not block another; stale snapshots render the fresh decision',async()=>{
  const rows=['first','second'].map(id=>({id,project_id:'project',workspace_id:'workspace',state:'awaiting',updated_at:'old'}))
  const writes:Array<{value:Record<string,unknown>,filters:unknown[][]}>=[]
  mocks.rpc.mockResolvedValue({data:true,error:null})
  mocks.get.mockImplementation(async(id:string)=>({...rows.find(r=>r.id===id),state:'approved',approved_name:'R&F_A_B_Edit_V1.mov',approved_by:'U123',
    slack_channel_id:'C123',slack_message_ts:id,source_path:'test.mov',source_payload:{subfolder:'01_Client Progress'},updated_at:'new'}))
  mocks.from.mockImplementation((table:string)=>{
    let mutation:typeof writes[number]|undefined
    const filters:unknown[][]=[]
    const query={select:()=>query,eq:(...args:unknown[])=>{filters.push(args);return query},order:()=>query,limit:()=>query,
      update:(value:Record<string,unknown>)=>{mutation={value,filters};writes.push(mutation);return query},
      single:async()=>({data:{project_manager_slack_id:'U123',external_ids:{},project_code:'TEST',name:'Test'},error:null}),
      then:(resolve:(v:unknown)=>unknown)=>Promise.resolve({data:mutation?null:table==='frame_upload_approvals'?rows:null,error:null}).then(resolve)}
    return query
  })
  mocks.update.mockRejectedValueOnce(new Error('Slack unavailable')).mockResolvedValue({ok:true})
  vi.spyOn(console,'warn').mockImplementation(()=>{})
  await syncUploadApprovalNotices({client:{chat:{update:mocks.update}}} as unknown as App)
  expect(mocks.update).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(mocks.update.mock.calls[1][0])).toContain('Approved by <@U123>')
  expect(mocks.update.mock.calls[1][0].blocks.some((b:{type:string})=>b.type==='actions')).toBe(false)
  expect(writes.some(w=>w.value.notice_dirty===true&&w.filters.some(f=>f[0]==='id'&&f[1]==='first'))).toBe(true)
  expect(writes.some(w=>w.value.notice_dirty===false&&w.filters.some(f=>f[0]==='updated_at'&&f[1]==='new'))).toBe(true)
  expect(writes.filter(w=>w.value.notice_token===null)).toHaveLength(2)
})
