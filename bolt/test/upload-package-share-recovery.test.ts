import { beforeEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const mocks=vi.hoisted(()=>({from:vi.fn(),sync:vi.fn(),post:vi.fn(),or:vi.fn()}))
vi.mock('../../src/lib/supabase/admin',()=>({createAdminClient:()=>({from:mocks.from})}))
vi.mock('../../src/lib/project-control/share-progress',()=>({syncProjectShareEvent:mocks.sync,registerProjectShare:vi.fn()}))
import { reconcilePendingProjectShares } from '../src/watchers/dropbox'
beforeEach(()=>{
  vi.resetAllMocks()
  mocks.sync.mockResolvedValue({eventId:'event',milestone:null,confidence:'uncertain'})
  mocks.from.mockImplementation(()=>{
    const q={select:()=>q,eq:()=>q,is:()=>q,or:(value:string)=>{mocks.or(value);return q},order:()=>q,limit:async()=>({data:[{id:'event',notification_disposition:'package'}],error:null})}
    return q
  })
})
it('recovers package Sheet work without another Slack ping or fabricated Slack receipt',async()=>{
  const app={client:{chat:{postMessage:mocks.post}}} as unknown as App
  expect(await reconcilePendingProjectShares(app)).toEqual({scanned:1,recovered:1,failed:0})
  expect(mocks.sync).toHaveBeenCalledWith('event');expect(mocks.post).not.toHaveBeenCalled()
  expect(mocks.or).toHaveBeenCalledWith('notification_disposition.eq.separate,suggested_milestone.is.null')
  expect(mocks.from).toHaveBeenCalledTimes(1)
})
