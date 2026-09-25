import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideStaleOutcome, reconcileStaleTransfers, type StaleTransferRow, type ProviderState } from './stale-transfer-reconciler'
const row: StaleTransferRow = { id:'t',project_id:'p',state:'processing',frameio_file_id:'f',dropbox_rev:'r',
  created_at:'2026-09-01T00:00:00Z',retired_at:null,frameio_upload_enabled:true }
const good: ProviderState = { exists:true,transcodeComplete:true,hasShare:true,sizeMatches:true,identityMatches:true }
test('only exact positive evidence is a ready candidate, never an applied state', () => {
  assert.equal(decideStaleOutcome(row,good).outcome,'verified_ready_candidate')
  for (const provider of [null,{...good,sizeMatches:null},{...good,sizeMatches:false},
    {...good,identityMatches:false},{...good,transcodeComplete:false},{...good,hasShare:false},
    {...good,exists:false,httpStatus:404}]) {
    assert.equal(decideStaleOutcome(row,provider).outcome,'leave_unresolved')
  }
})
test('read-only collection skips retired, disabled and completed transfers', async () => {
  const seen: string[]=[]
  const result=await reconcileStaleTransfers({loadStaleProcessing:async()=>[
    {...row,id:'retired',retired_at:'2026-09-24T00:00:00Z'},
    {...row,id:'disabled',frameio_upload_enabled:false},{...row,id:'ready',state:'ready'},row,
  ]}, {env:{STALE_TRANSFER_RECONCILER_ENABLED:'true'},verifyProvider:async r=>{seen.push(r.id);return good}})
  assert.deepEqual(seen,['t'])
  assert.equal(result.skipped.length,3)
  assert.equal(result.applied,0)
})
test('write mode is rejected before reads, including a concurrently retired snapshot',async()=>{
  let read=false
  await assert.rejects(reconcileStaleTransfers({loadStaleProcessing:async()=>{read=true;return [row]}},
    {dryRun:false,env:{STALE_TRANSFER_RECONCILER_ENABLED:'true'},verifyProvider:async()=>good}),/read-only/)
  assert.equal(read,false)
})
test('disabled mode reads nothing and unavailable providers leave rows unresolved',async()=>{
  let read=false
  const client={loadStaleProcessing:async()=>{read=true;return [row]}}
  await reconcileStaleTransfers(client,{env:{},verifyProvider:async()=>good})
  assert.equal(read,false)
  const result=await reconcileStaleTransfers(client,{env:{STALE_TRANSFER_RECONCILER_ENABLED:'true'},
    verifyProvider:async()=>{throw new Error('outage')}})
  assert.equal(result.decisions[0].outcome,'leave_unresolved')
  assert.equal(result.applied,0)
})
