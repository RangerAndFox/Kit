import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
import type { UploadApproval } from '../../src/lib/delivery/upload-approval'
const mocks=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn(),get:vi.fn(),reconcile:vi.fn(),update:vi.fn(),deliver:vi.fn(),open:vi.fn()}))
vi.mock('../../src/lib/supabase/admin',()=>({createAdminClient:()=>({from:mocks.from,rpc:mocks.rpc})}))
vi.mock('../../src/lib/delivery/upload-approval-store',()=>({uploadApprovalsEnabled:()=>true,getUploadApproval:mocks.get}))
vi.mock('../src/watchers/dropbox',()=>({reconcilePendingUploadApproval:mocks.reconcile}))
vi.mock('../../src/lib/slack/durable-delivery',()=>({deliverSlackOnce:mocks.deliver}))
import { syncUploadApprovalNotices } from '../src/watchers/upload-review-notices'

type Slot={id:string;workspace_id:string;project_id:string;current_approval_id:string;anchor_approval_id:string;generation:number;slack_channel_id:string|null;slack_message_ts:string|null}
type Context={slot:Slot;current:UploadApproval;completed:UploadApproval|null;legacy:UploadApproval[];dirty_approvals:Array<{id:string;updated_at:string}>}
let row:UploadApproval,slot:Slot,contexts:Map<string,Context>,rows:Map<string,UploadApproval>,slots:Slot[]
const app={client:{chat:{update:mocks.update},conversations:{open:mocks.open}}} as unknown as App
beforeEach(()=>{
  vi.resetAllMocks()
  row={id:'request',workspace_id:'workspace',project_id:'project',review_slot_id:'slot',state:'awaiting',
    source_path:'/edit.mp4',suggested_name:'R&F_A_B_Edit_V3.mp4',source_payload:{subfolder:'01_Client Progress'},
    updated_at:'now',approved_by:'UPRODUCER',approved_name:'R&F_A_B_Edit_V3.mp4',approval_version:1} as UploadApproval
  slot={id:'slot',workspace_id:'workspace',project_id:'project',current_approval_id:'request',anchor_approval_id:'original',
    generation:3,slack_channel_id:'GSHARED',slack_message_ts:'100.1'}
  rows=new Map([[row.id,row]]);slots=[slot]
  contexts=new Map([[slot.id,{slot,current:{...row},completed:{...row,id:'complete',state:'complete',frame_file_id:'original-frame'},
    legacy:[],dirty_approvals:[{id:row.id,updated_at:row.updated_at}]}]])
  mocks.get.mockImplementation(async(id:string)=>({...rows.get(id)}))
  mocks.reconcile.mockResolvedValue(undefined)
  mocks.open.mockImplementation(async({users}:{users:string})=>({channel:{id:users==='UPRODUCER'?'DAPPROVER':'GSHARED'}}))
  mocks.update.mockResolvedValue({ok:true})
  mocks.deliver.mockResolvedValue('400.1')
  mocks.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>({data:name==='list_pending_frame_upload_reviews'?slots:name==='claim_frame_upload_review_slot'?contexts.get(String(args.p_id))||null:true,error:null}))
  mocks.from.mockImplementation((table:string)=>{
    let mutation:Record<string,unknown>|undefined
    const filters:unknown[][]=[]
    const query={select:()=>query,eq:(...args:unknown[])=>{filters.push(args);return query},is:(...args:unknown[])=>{filters.push(args);return query},in:()=>query,order:()=>query,limit:()=>query,
      update:(value:Record<string,unknown>)=>{mutation=value;return query},
      single:async()=>({data:{project_manager_slack_id:'UPRODUCER',external_ids:{creative_director_slack_id:'UCD'},project_code:'2645',name:'Cloud PC'},error:null}),
      then:(resolve:(v:unknown)=>unknown)=>{
        if(mutation&&table==='frame_upload_approvals') {
          const id=filters.find(f=>f[0]==='id')?.[1]
          const existing=rows.get(String(id));if(existing) Object.assign(existing,mutation)
        }
        return Promise.resolve({data:mutation?null:table==='frame_upload_review_slots'?slots:
          [...rows.values()].filter(r=>!filters.some(f=>f[0]==='review_slot_id'&&f[1]===null)||!r.review_slot_id).map(r=>({id:r.id,review_slot_id:r.review_slot_id})),error:null}).then(resolve)
      }}
    return query
  })
  vi.spyOn(console,'warn').mockImplementation(()=>{})
})
afterEach(()=>vi.restoreAllMocks())

it('updates the adopted card quietly; completed upload stays complete and changed source needs its own decision',async()=>{
  await syncUploadApprovalNotices(app)
  expect(mocks.deliver).not.toHaveBeenCalled()
  const sent=mocks.update.mock.calls[0][0]
  expect(sent).toMatchObject({channel:'GSHARED',ts:'100.1'})
  expect(sent.text).toContain('source change detected')
  expect(JSON.stringify(sent)).toContain('previous approved upload remains complete')
  expect(sent.blocks.find((b:{type:string})=>b.type==='actions').elements[0].value).toBe('request')
  expect(contexts.get('slot')!.completed?.state).toBe('complete')
  expect(mocks.rpc).toHaveBeenCalledWith('finish_frame_upload_review_notice',expect.objectContaining({p_success:true,p_generation:3}))
})
it('fresh decision read after acquiring lease prevents an old awaiting snapshot restoring buttons',async()=>{
  mocks.get.mockResolvedValueOnce({...row}).mockResolvedValue({...row,state:'approved'})
  await syncUploadApprovalNotices(app)
  const content=mocks.update.mock.calls[0][0]
  expect(content.blocks.some((b:{type:string})=>b.type==='actions')).toBe(false)
  expect(JSON.stringify(content)).toContain('Approved by <@UPRODUCER>')
})
it('one failed card does not starve another logical file',async()=>{
  const second={...row,id:'second',review_slot_id:'slot2',state:'approved'}
  rows.set('second',second);const slot2={...slot,id:'slot2',current_approval_id:'second',slack_message_ts:'200.1'}
  slots.push(slot2);contexts.set('slot2',{slot:slot2,current:second,completed:null,legacy:[],dirty_approvals:[{id:'second',updated_at:'now'}]})
  mocks.update.mockRejectedValueOnce(new Error('Slack unavailable'))
  await syncUploadApprovalNotices(app)
  expect(mocks.update).toHaveBeenCalledTimes(2)
  expect(mocks.rpc).toHaveBeenCalledWith('finish_frame_upload_review_notice',expect.objectContaining({p_id:'slot',p_success:false}))
  expect(mocks.rpc).toHaveBeenCalledWith('finish_frame_upload_review_notice',expect.objectContaining({p_id:'slot2',p_success:true}))
})
it('an unconfirmed send retains the original durable key instead of reposting under a new revision ID',async()=>{
  slot.slack_message_ts=null
  mocks.deliver.mockRejectedValue(new Error('Unknown Slack outcome'))
  await syncUploadApprovalNotices(app);await syncUploadApprovalNotices(app)
  expect(mocks.deliver).toHaveBeenCalledTimes(2)
  for(const [args] of mocks.deliver.mock.calls) expect(args).toMatchObject({key:'frame-upload-review:original',channel:'GSHARED'})
  expect(mocks.update).not.toHaveBeenCalled()
  for(const [,args] of mocks.rpc.mock.calls.filter(([n])=>n==='finish_frame_upload_review_notice')) expect(args.p_success).toBe(false)
})
it('a concurrent sender with the logical-file lease causes no Slack write',async()=>{
  mocks.rpc.mockImplementation(async(name:string)=>({data:name==='list_pending_frame_upload_reviews'?slots:name==='claim_frame_upload_review_slot'?null:true,error:null}))
  await syncUploadApprovalNotices(app)
  expect(mocks.update).not.toHaveBeenCalled();expect(mocks.deliver).not.toHaveBeenCalled()
})
it('cannot publish private source details to an outdated reviewer group',async()=>{
  mocks.open.mockResolvedValue({channel:{id:'GOTHER'}})
  await syncUploadApprovalNotices(app)
  expect(mocks.update).not.toHaveBeenCalled();expect(mocks.deliver).not.toHaveBeenCalled()
  expect(mocks.rpc).toHaveBeenCalledWith('finish_frame_upload_review_notice',expect.objectContaining({p_success:false}))
})
it('collision controls go only to the original approver and reuse their receipt',async()=>{
  row.state='collision'
  await syncUploadApprovalNotices(app)
  expect(mocks.deliver).toHaveBeenCalledWith(expect.objectContaining({key:'frame-upload-collision:request',channel:'DAPPROVER'}))
  expect(mocks.update.mock.calls[0][0].blocks.some((b:{type:string})=>b.type==='actions')).toBe(false)
  row.state='approved'
  await syncUploadApprovalNotices(app)
  expect(mocks.deliver).toHaveBeenCalledTimes(1)
  expect(mocks.update.mock.calls.some(([a])=>a.channel==='DAPPROVER'&&a.ts==='400.1'&&!a.blocks.some((b:{type:string})=>b.type==='actions'))).toBe(true)
})
it('closes legacy copies without deleting their history or publishing another message',async()=>{
  const legacy={...row,id:'obsolete',state:'superseded',slack_channel_id:'GSHARED',slack_message_ts:'200.1'}
  contexts.get('slot')!.legacy=[legacy]
  await syncUploadApprovalNotices(app)
  const old=mocks.update.mock.calls.find(([a])=>a.ts==='200.1')![0]
  expect(old.blocks.some((b:{type:string})=>b.type==='actions')).toBe(false)
  expect(mocks.rpc).toHaveBeenCalledWith('close_legacy_frame_upload_notice',expect.objectContaining({p_slot:'slot',p_approval:'obsolete',p_ts:'200.1'}))
  expect(mocks.deliver).not.toHaveBeenCalled()
})
it('a lost lease prevents any subsequent Slack write or successful acknowledgment',async()=>{
  mocks.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>({data:name==='list_pending_frame_upload_reviews'?slots:name==='claim_frame_upload_review_slot'?contexts.get(String(args.p_id)):name==='save_frame_upload_review_receipt'?false:true,error:null}))
  await syncUploadApprovalNotices(app)
  expect(mocks.update).not.toHaveBeenCalled()
  expect(mocks.rpc).toHaveBeenCalledWith('finish_frame_upload_review_notice',expect.objectContaining({p_success:false}))
})
it('an inaccessible legacy card cannot block collision controls or current outcome acknowledgments',async()=>{
  row.state='collision'
  contexts.get('slot')!.legacy=[{...row,id:'old',slack_channel_id:'GSHARED',slack_message_ts:'200.1'}]
  mocks.update.mockImplementation(async(args:{ts:string})=>{
    if(args.ts==='200.1') throw new Error('message_not_found')
    return {ok:true}
  })
  await syncUploadApprovalNotices(app)
  expect(mocks.deliver).toHaveBeenCalledWith(expect.objectContaining({key:'frame-upload-collision:request',channel:'DAPPROVER'}))
  expect(mocks.rpc).not.toHaveBeenCalledWith('close_legacy_frame_upload_notice',expect.anything())
  expect(mocks.rpc).toHaveBeenCalledWith('finish_frame_upload_review_notice',expect.objectContaining({p_success:true}))
  expect(mocks.update.mock.calls[0][0]).toMatchObject({channel:'GSHARED',ts:'100.1'})
})
it('a lost lease while closing a legacy card still prevents collision publication',async()=>{
  row.state='collision'
  contexts.get('slot')!.legacy=[{...row,id:'old',slack_channel_id:'GSHARED',slack_message_ts:'200.1'}]
  mocks.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>({data:name==='list_pending_frame_upload_reviews'?slots:name==='claim_frame_upload_review_slot'?contexts.get(String(args.p_id)):name==='close_legacy_frame_upload_notice'?false:true,error:null}))
  await syncUploadApprovalNotices(app)
  expect(mocks.deliver).not.toHaveBeenCalled()
  expect(mocks.rpc).toHaveBeenCalledWith('finish_frame_upload_review_notice',expect.objectContaining({p_success:false}))
})
it('unknown provider state does not retire a pending source or send a new prompt',async()=>{
  mocks.reconcile.mockRejectedValue(new Error('Source proof unavailable'))
  await syncUploadApprovalNotices(app)
  expect(mocks.rpc.mock.calls.some(([name])=>name==='claim_frame_upload_review_slot')).toBe(false)
  expect(mocks.update).not.toHaveBeenCalled();expect(mocks.deliver).not.toHaveBeenCalled()
})
