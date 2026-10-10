import { afterEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const mocks = vi.hoisted(() => ({ from:vi.fn(), rpc:vi.fn(), get:vi.fn(), update:vi.fn(), deliver:vi.fn() }))
vi.mock('../../src/lib/supabase/admin',()=>({createAdminClient:()=>({from:mocks.from,rpc:mocks.rpc})}))
vi.mock('../../src/lib/delivery/upload-approval-store',()=>({uploadApprovalsEnabled:()=>true,getUploadApproval:mocks.get,assertUploadReviewer:vi.fn()}))
vi.mock('../src/watchers/dropbox',()=>({uploadApprovalConflicts:vi.fn(),verifyApprovalSource:vi.fn()}))
vi.mock('../../src/lib/slack/durable-delivery',()=>({deliverSlackOnce:mocks.deliver}))
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

it('sends collision controls only to the original approver and reuses the durable receipt',async()=>{
  vi.clearAllMocks()
  const row={id:'collision-request',workspace_id:'workspace',project_id:'project',state:'collision',approved_by:'UPRODUCER',
    approved_name:'R&F_A_B_Edit_V1.mov',approval_version:1,source_path:'test.mov',source_payload:{subfolder:'01_Client Progress'},
    slack_channel_id:'GSHARED',slack_message_ts:'shared-ts',updated_at:'now',collision_channel_id:null as string|null,collision_message_ts:null as string|null}
  mocks.get.mockImplementation(async()=>({...row}))
  mocks.rpc.mockResolvedValue({data:true,error:null})
  mocks.update.mockResolvedValue({ok:true})
  mocks.deliver.mockResolvedValue('private-ts')
  mocks.from.mockImplementation(()=>{
    let mutation:Record<string,unknown>|undefined
    const query={select:()=>query,eq:()=>query,order:()=>query,limit:()=>query,
      update:(value:Record<string,unknown>)=>{mutation=value;return query},
      single:async()=>({data:{project_manager_slack_id:'UPRODUCER',external_ids:{creative_director_slack_id:'UCD'},project_code:'TEST',name:'Test'},error:null}),
      then:(resolve:(v:unknown)=>unknown)=>{
        if(mutation) Object.assign(row,mutation)
        return Promise.resolve({data:mutation?null:[row],error:null}).then(resolve)
      }}
    return query
  })
  const open=vi.fn().mockResolvedValue({channel:{id:'DAPPROVER'}})
  const app={client:{chat:{update:mocks.update},conversations:{open}}} as unknown as App
  await syncUploadApprovalNotices(app)
  expect(open).toHaveBeenCalledExactlyOnceWith({users:'UPRODUCER'})
  expect(mocks.deliver).toHaveBeenCalledWith(expect.objectContaining({key:'frame-upload-collision:collision-request',channel:'DAPPROVER'}))
  expect(mocks.update.mock.calls[0][0].channel).toBe('GSHARED')
  expect(mocks.update.mock.calls[0][0].blocks.some((b:{type:string})=>b.type==='actions')).toBe(false)
  row.state='approved'
  await syncUploadApprovalNotices(app)
  expect(mocks.deliver).toHaveBeenCalledTimes(1)
  const privateUpdate=mocks.update.mock.calls.find(([args])=>args.channel==='DAPPROVER')?.[0]
  expect(privateUpdate?.ts).toBe('private-ts')
  expect(privateUpdate?.blocks.some((b:{type:string})=>b.type==='actions')).toBe(false)
})
