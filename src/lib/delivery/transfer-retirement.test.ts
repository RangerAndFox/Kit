import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retireTransfers, type RetirementTarget, type RetirementClient } from './transfer-retirement'
const target: RetirementTarget = {transferId:'t',projectId:'p',dropboxFileId:'file',dropboxRev:'old',
  expectedUpdatedAt:'2026-09-24T00:00:00Z',expectedEventIds:['exact-event']}
test('dry-run is the default and preserves exact revision/event manifest',async()=>{
  const client: RetirementClient={retireAtomically:async(t,reason,actor,dryRun)=>{
    assert.deepEqual(t,target);assert.equal(dryRun,true);assert.equal(reason,'retire');assert.equal(actor,'admin')
    return {transferId:t.transferId,disposition:'eligible',inboxEvents:1}
  }}
  const result=await retireTransfers(client,{targets:[target],reason:'retire',retiredBy:'admin'})
  assert.equal(result.dryRun,true)
})
test('a transaction failure is surfaced; retry invokes the entire atomic operation',async()=>{
  let attempts=0
  const client: RetirementClient={retireAtomically:async(t)=>{
    if (++attempts===1) throw new Error('transaction rolled back')
    return {transferId:t.transferId,disposition:'retired',inboxEvents:1}
  }}
  const opts={targets:[target],reason:'retire',retiredBy:'admin',dryRun:false}
  await assert.rejects(retireTransfers(client,opts),/rolled back/)
  assert.equal((await retireTransfers(client,opts)).receipts[0].disposition,'retired')
  assert.equal(attempts,2)
})
test('completed atomic retirements return verified receipts on retries',async()=>{
  const client: RetirementClient={retireAtomically:async(t)=>({transferId:t.transferId,disposition:'already_retired',inboxEvents:1})}
  assert.equal((await retireTransfers(client,{targets:[target],reason:'retire',retiredBy:'admin',dryRun:false})).receipts[0].disposition,'already_retired')
})
