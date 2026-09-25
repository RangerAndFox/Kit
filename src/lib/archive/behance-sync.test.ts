import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliverBehanceUpdate } from './behance-sync'

test('Slack failure leaves the exact Behance version unacknowledged and retryable', async () => {
  const calls: string[] = []
  let fail = true
  const steps = {
    prepare: async () => { calls.push('prepare'); return { version: 'v1' } },
    deliver: async () => { calls.push('slack'); if (fail) throw new Error('Slack unavailable') },
    acknowledge: async () => { calls.push('ack') },
  }
  await assert.rejects(deliverBehanceUpdate(steps), /Slack unavailable/)
  assert.deepEqual(calls, ['prepare','slack'])
  fail = false
  await deliverBehanceUpdate(steps)
  assert.deepEqual(calls, ['prepare','slack','prepare','slack','ack'])
})

test('changed-version acknowledgement fails instead of consuming new work', async () => {
  await assert.rejects(deliverBehanceUpdate({
    prepare: async () => 'old-version',
    deliver: async () => {},
    acknowledge: async () => { throw new Error('version changed') },
  }), /version changed/)
})
