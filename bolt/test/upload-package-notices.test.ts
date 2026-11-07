import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
import type { UploadPackagePage, UploadReviewPackage } from '../../src/lib/delivery/upload-package'
const mocks=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),page:vi.fn(),open:vi.fn(),update:vi.fn(),deliver:vi.fn()}))
vi.mock('../../src/lib/supabase/admin',()=>({createAdminClient:()=>({rpc:mocks.rpc,from:mocks.from})}))
vi.mock('../../src/lib/delivery/upload-package-store',()=>({getUploadPackagePage:mocks.page}))
vi.mock('../../src/lib/slack/durable-delivery',()=>({deliverSlackOnce:mocks.deliver}))
import { syncUploadPackageNotices } from '../src/watchers/upload-package-notices'
let pack:UploadReviewPackage,page:UploadPackagePage
const app={client:{chat:{update:mocks.update},conversations:{open:mocks.open}}} as unknown as App
beforeEach(()=>{
  vi.resetAllMocks()
  pack={id:'package',workspace_id:'ws',project_id:'project',root_path:'/production/2026/project/09_Outgoing/02_Delivery/date',generation:3,notice_dirty:true,slack_channel_id:'GSHARED',slack_message_ts:null}
  page={package:pack,approvals:[],total:19,awaiting:19,next_cursor:null}
  mocks.page.mockResolvedValue(page)
  mocks.rpc.mockImplementation(async(name:string)=>({data:name==='list_pending_frame_upload_packages'?[{...pack}]:true,error:null}))
  mocks.from.mockImplementation(()=>{const q={select:()=>q,eq:()=>q,single:async()=>({data:{project_manager_slack_id:'UPRODUCER',external_ids:{creative_director_slack_id:'UCD'},project_code:'2645',name:'Cloud PC',status:'active'},error:null})};return q})
  mocks.open.mockResolvedValue({channel:{id:'GSHARED'}});mocks.update.mockResolvedValue({ok:true});mocks.deliver.mockResolvedValue('100.1')
  vi.spyOn(console,'warn').mockImplementation(()=>{})
})
afterEach(()=>vi.restoreAllMocks())
it('posts one durable root card for all nested files and quietly updates its saved receipt',async()=>{
  await syncUploadPackageNotices(app)
  expect(mocks.deliver).toHaveBeenCalledTimes(1)
  expect(mocks.deliver).toHaveBeenCalledWith(expect.objectContaining({key:'frame-upload-package:package',channel:'GSHARED'}))
  expect(mocks.rpc).toHaveBeenCalledWith('save_frame_upload_package_receipt',expect.objectContaining({p_ts:'100.1'}))
  pack.slack_message_ts='100.1';page.awaiting=4
  await syncUploadPackageNotices(app)
  expect(mocks.deliver).toHaveBeenCalledTimes(1);expect(mocks.update).toHaveBeenCalledTimes(2)
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({channel:'GSHARED',ts:'100.1',text:expect.stringContaining('4 awaiting')}))
})
it('refreshes a recovered durable send before acknowledging the current generation',async()=>{
  page.awaiting=2
  mocks.deliver.mockResolvedValue('prior.1')
  await syncUploadPackageNotices(app)
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ts:'prior.1',text:expect.stringContaining('2 awaiting')}))
  mocks.update.mockRejectedValueOnce(new Error('Slack unavailable'))
  await syncUploadPackageNotices(app)
  expect(mocks.rpc).toHaveBeenLastCalledWith('finish_frame_upload_package_notice',expect.objectContaining({p_success:false}))
})
it('adopts an existing receipt without reposting any historical cards',async()=>{
  pack.slack_message_ts='old.1'
  await syncUploadPackageNotices(app)
  expect(mocks.deliver).not.toHaveBeenCalled()
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ts:'old.1'}))
})
it('uses the identical durable key after an uncertain send and never claims success',async()=>{
  mocks.deliver.mockRejectedValue(new Error('Unknown outcome'))
  await syncUploadPackageNotices(app);await syncUploadPackageNotices(app)
  for(const [args] of mocks.deliver.mock.calls) expect(args.key).toBe('frame-upload-package:package')
  for(const [,args] of mocks.rpc.mock.calls.filter(([name])=>name==='finish_frame_upload_package_notice')) expect(args.p_success).toBe(false)
})
it('a concurrent lease owner or lost checkpoint stops the write',async()=>{
  mocks.rpc.mockImplementation(async(name:string)=>({data:name==='list_pending_frame_upload_packages'?[pack]:false,error:null}))
  await syncUploadPackageNotices(app)
  expect(mocks.page).not.toHaveBeenCalled();expect(mocks.deliver).not.toHaveBeenCalled()
  mocks.rpc.mockImplementation(async(name:string)=>({data:name==='list_pending_frame_upload_packages'?[pack]:name==='save_frame_upload_package_receipt'?false:true,error:null}))
  await syncUploadPackageNotices(app)
  expect(mocks.deliver).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled()
})
it('does not leak the package to a changed recipient group or another workspace',async()=>{
  mocks.open.mockResolvedValue({channel:{id:'GOTHER'}})
  await syncUploadPackageNotices(app)
  expect(mocks.deliver).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled()
  mocks.open.mockResolvedValue({channel:{id:'GSHARED'}})
  mocks.page.mockResolvedValue({...page,package:{...pack,workspace_id:'other'}})
  await syncUploadPackageNotices(app)
  expect(mocks.deliver).not.toHaveBeenCalled()
})
it('acknowledges only the generation actually rendered, not a later file arrival',async()=>{
  mocks.update.mockImplementation(async()=>{pack.generation=4;return {ok:true}})
  pack.slack_message_ts='100.1'
  await syncUploadPackageNotices(app)
  expect(mocks.rpc).toHaveBeenCalledWith('finish_frame_upload_package_notice',expect.objectContaining({p_generation:3,p_success:true}))
})
