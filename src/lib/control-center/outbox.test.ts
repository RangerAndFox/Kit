import { it } from 'node:test'
import assert from 'node:assert/strict'
import { deliverOutbox, type OutboxPorts, type OutboxRow } from './outbox'
import { retryIncompleteSync, requireCompletedSync, type SyncSummary } from '../inngest/project-control-sync'

const row: OutboxRow = { id: 'id', project_id: 'project', kind: 'sync_alert', payload: {}, attempts: 1, send_started: false, created_at: '2026-09-11T00:00:00Z' }
function fake(over: Partial<OutboxPorts> = {}) {
  const events: string[] = []
  const ports: OutboxPorts = {
    markStarted: async () => { events.push('checkpoint') },
    reconcile: async () => ({ state: 'absent' }),
    post: async () => { events.push('post'); return { ok: true, ts: '123' } },
    action: async () => { events.push('action') },
    finish: async (status) => { events.push(status) }, ...over,
  }
  return { ports, events }
}

it('persists a checkpoint before sending and marks sent only after acknowledgement', async () => {
  const { ports, events } = fake()
  await deliverOutbox(row, ports)
  assert.deepEqual(events, ['checkpoint', 'post', 'sent'])
})
it('does not send when its checkpoint fails', async () => {
  const { ports, events } = fake({ markStarted: async () => { throw new Error('database unavailable') } })
  await deliverOutbox(row, ports)
  assert.deepEqual(events, ['retry'])
})
it('reconciles a timeout after Slack accepted without reposting', async () => {
  const first = fake({ post: async () => { throw new Error('timeout') } })
  await deliverOutbox(row, first.ports)
  assert.deepEqual(first.events, ['checkpoint', 'retry'])
  const second = fake({ reconcile: async () => ({ state: 'found', ts: '123' }) })
  await deliverOutbox({ ...row, send_started: true }, second.ports)
  assert.deepEqual(second.events, ['sent'])
})
it('never reposts an ambiguous delivery when history is unavailable', async () => {
  const { ports, events } = fake({ reconcile: async () => ({ state: 'unknown' }) })
  await deliverOutbox({ ...row, send_started: true, attempts: 12 }, ports)
  assert.deepEqual(events, ['review'])
})
it('definitive Slack errors do not become successful deliveries', async () => {
  const { ports, events } = fake({ post: async () => ({ ok: false }) })
  await deliverOutbox(row, ports)
  assert.deepEqual(events, ['checkpoint', 'retry'])
})
it('action execution failures remain recoverable, not successful', async () => {
  const { ports, events } = fake({ action: async () => { throw new Error('provider unavailable') } })
  await deliverOutbox({ ...row, kind: 'control_action' }, ports)
  assert.deepEqual(events, ['retry'])
})
it('busy and lost sync leases trigger retries; successful sync is accepted', () => {
  const result: SyncSummary = { ran: false, considered: 0, updated: 0, unchanged: 0, orphaned: 0, errored: 0, cursorAdvanced: false }
  assert.throws(() => retryIncompleteSync({ ...result, reason: 'sync_lease_unavailable' }))
  assert.throws(() => retryIncompleteSync({ ...result, reason: 'sync_lease_lost' }))
  assert.throws(() => requireCompletedSync({ ...result, reason: 'disabled' }))
  assert.throws(() => retryIncompleteSync({ ...result, ran: true, errored: 1 }))
  assert.equal(requireCompletedSync({ ...result, ran: true, considered: 1 }).ran, true)
})
