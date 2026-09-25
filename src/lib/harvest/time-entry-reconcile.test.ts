import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTimeEntry } from './client'
import type { TimeIntentStore } from './time-intents'

const opts = { projectId: 1, taskId: 2, userId: 3, spentDate: '2026-09-25', hours: 4, notes: 'Animation', idempotencyKey: 'intent' }
const entry = { id: 55, project: { id: 1, name: 'Launch' }, task: { id: 2, name: 'Design' }, user: { id: 3, name: 'Artist' }, spent_date: opts.spentDate, hours: 4, notes: 'Animation [Kit:intent]' }

test('real Harvest client preflight: pagination, legacy matching, conflict, outage and shared identity isolation', async t => {
  const previous = { token: process.env.HARVEST_ACCESS_TOKEN, account: process.env.HARVEST_ACCOUNT_ID }
  process.env.HARVEST_ACCESS_TOKEN = 'test-only'
  process.env.HARVEST_ACCOUNT_ID = 'test-account'
  t.after(() => {
    if (previous.token === undefined) delete process.env.HARVEST_ACCESS_TOKEN
    else process.env.HARVEST_ACCESS_TOKEN = previous.token
    if (previous.account === undefined) delete process.env.HARVEST_ACCOUNT_ID
    else process.env.HARVEST_ACCOUNT_ID = previous.account
  })
  let claims = 0, posts = 0
  const store: TimeIntentStore = { claim: async () => { claims++; return true }, commit: async () => {}, reconcile: async () => {}, reject: async () => {} }
  let mode = 'page2'
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (init?.method === 'POST') { posts++; return Response.json(entry) }
    if (mode === 'outage') return new Response('unavailable', { status: 503 })
    if (mode === 'cycle') return Response.json({ time_entries: [], next_page: 1 })
    if (mode === 'modified') return Response.json({ time_entries: [{ ...entry, hours: 5 }], next_page: null })
    if (mode === 'legacy') return Response.json({ time_entries: [{ ...entry, notes: 'Animation [Kit:old-row:abc]' }], next_page: null })
    return Response.json(url.searchParams.get('page') === '1' ? { time_entries: [], next_page: 2 } : { time_entries: [entry], next_page: null })
  })
  assert.equal((await createTimeEntry(opts, { intentStore: store })).reused, true)
  assert.equal(fetchMock.mock.callCount(), 2)
  mode = 'legacy'
  assert.equal((await createTimeEntry({ ...opts, dedupeContent: true }, { intentStore: store })).reused, true)
  assert.equal(posts, 0)
  mode = 'modified'
  await assert.rejects(createTimeEntry(opts, { intentStore: store }), /modified/)
  mode = 'outage'
  await assert.rejects(createTimeEntry(opts, { intentStore: store }), /503/)
  mode = 'cycle'
  await assert.rejects(createTimeEntry(opts, { intentStore: store }), /pagination incomplete/)
  assert.equal(claims, 0)
  mode = 'legacy'
  await createTimeEntry({ ...opts, dedupeContent: false }, { intentStore: store })
  assert.equal(posts, 1, 'another artist/shared bucket content is not a receipt for this intent')
})
