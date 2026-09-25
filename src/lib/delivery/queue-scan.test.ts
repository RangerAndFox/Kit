import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runQueueScan, isQueueInput, type QueueScanIO, type QueueFile } from './queue-scan'

const file: QueueFile = { id: 'id:file', name: 'movie.mp4', path_lower: '/delivery-queue/p/movie.mp4', path_display: '/Delivery-Queue/p/movie.mp4', size: 100, '.tag': 'file' }
test('delta scan checkpoints only saved pages, bounds discovery, and checks unchanged pending files across ticks', async () => {
  let cursor: string | null = null, calls = 0, count = 0
  const order: string[] = []
  const io: QueueScanIO = {
    claim: async () => ({ claimed: true, cursor }),
    page: async previous => { calls++; return { entries: previous ? [] : [file], cursor: `cursor-${calls}`, has_more: true } },
    record: async () => { order.push('record') }, checkpoint: async next => { order.push('checkpoint'); cursor = next },
    pending: async () => [{ dropbox_id: file.id, path: file.path_display, size_bytes: 100, stable_check_count: count }],
    metadata: async () => file, update: async (_, fields) => { count = Number(fields.stable_check_count) }, release: async () => {},
  }
  assert.deepEqual(await runQueueScan(io), [])
  assert.equal(calls, 2, 'bounded even when a large initial tree has more pages')
  assert.equal((await runQueueScan(io)).length, 1)
  assert.equal(calls, 4)
  assert.deepEqual(order, ['record','checkpoint','record','checkpoint','record','checkpoint','record','checkpoint'])
  io.record = async () => { throw new Error('db write failed') }
  const oldCursor = cursor
  await assert.rejects(runQueueScan(io), /db write failed/)
  assert.equal(cursor, oldCursor)
})

test('lost lease, unavailable provider, and moved/deleted inputs never become notification success', async () => {
  const updates: Record<string, unknown>[] = []
  const io: QueueScanIO = {
    claim: async () => ({ claimed: true, cursor: 'old' }), page: async () => ({ entries: [], cursor: 'new', has_more: false }),
    record: async () => {}, checkpoint: async () => {}, pending: async () => [{ dropbox_id: file.id, path: file.path_display, size_bytes: 100, stable_check_count: 1 }],
    metadata: async () => { throw new Error('not_found') }, update: async (_, fields) => { updates.push(fields) }, release: async () => {},
  }
  assert.deepEqual(await runQueueScan(io), [])
  assert.equal(updates[0].delivery_queue_missing, true)
  assert.equal(updates[0].notified_at, undefined)
  io.metadata = async () => { throw new Error('timeout') }
  await assert.rejects(runQueueScan(io), /timeout/)
  io.metadata = async () => file
  io.release = async () => { throw new Error('ownership lost') }
  await assert.rejects(runQueueScan(io), /ownership lost/)
  assert.equal(isQueueInput({ ...file, path_lower: '/delivery-queue/p/output/movie.mp4' }), false)
})
