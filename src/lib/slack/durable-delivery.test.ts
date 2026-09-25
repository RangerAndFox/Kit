import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deliverSlackOnce, type DeliveryStore } from './durable-delivery'
import type { SlackResponse } from './transport'

test('lost Slack acknowledgment is reconciled, racing sends do not duplicate, forged receipts ignored', async () => {
  let row: Awaited<ReturnType<DeliveryStore['claim']>> | undefined
  let posts = 0, saveFails = true, forged = true
  let messages: NonNullable<SlackResponse['messages']> = []
  const store: DeliveryStore = {
    claim: async (key, owner, channel, thread) => row ||= { delivery_key: key, owner, channel_id: channel, thread_ts: thread || null, message_ts: null, created_at: new Date().toISOString() },
    acknowledge: async (_, ts) => { if (saveFails) throw new Error('db unavailable'); row!.message_ts = ts },
    reject: async () => { row = undefined },
  }
  const call = async (method: string, body: Record<string, unknown>): Promise<SlackResponse> => {
    if (method === 'auth.test') return { ok: true, user_id: 'UKIT' }
    if (method === 'chat.postMessage') {
      posts++
      messages = [{ ts: '123.456', user: 'UKIT', metadata: body.metadata as NonNullable<SlackResponse['messages']>[number]['metadata'] }]
      return { ok: true, ts: '123.456' }
    }
    return { ok: true, messages: forged ? messages.map(m => ({ ...m, user: 'UOTHER' })) : messages }
  }
  const input = { key: 'job-1', channel: 'C1', text: 'Ready' }
  await assert.rejects(deliverSlackOnce(input, { store, call }), /db unavailable/)
  saveFails = false
  await assert.rejects(deliverSlackOnce(input, { store, call }), /unconfirmed/)
  assert.equal(posts, 1)
  forged = false
  const replies = await Promise.all([deliverSlackOnce(input, { store, call }), deliverSlackOnce(input, { store, call })])
  assert.deepEqual(replies, ['123.456', '123.456'])
  assert.equal(posts, 1)
})

test('history errors, bounded incomplete search, and empty history never authorize repost', async () => {
  let calls = 0, posts = 0
  const store: DeliveryStore = {
    claim: async (key, _owner, channel) => ({ delivery_key: key, owner: 'old-worker', channel_id: channel, thread_ts: null, message_ts: null, created_at: new Date().toISOString() }),
    acknowledge: async () => {}, reject: async () => { throw new Error('must retain hold') },
  }
  await assert.rejects(deliverSlackOnce({ key: 'job', channel: 'C1', text: 'Ready' }, { store, call: async method => {
    if (method === 'auth.test') return { ok: true, user_id: 'UKIT' }
    if (method === 'chat.postMessage') posts++
    calls++
    return { ok: true, messages: [], response_metadata: { next_cursor: 'more' } }
  } }), /unconfirmed/)
  assert.equal(calls, 5)
  assert.equal(posts, 0)
})
