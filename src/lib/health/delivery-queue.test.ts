import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliveryQueueDetail } from './delivery-queue'

const row = { event_type: 'frameio_delivery', last_error: 'Dropbox /files/get_metadata 409: path/not_found/',
  payload: { safeName: '2636_Microsoft_CCAI', name: 'private/folder/captions.vtt' } }
test('reports the total backlog, project, basename and actionable reason', () => {
  const detail = deliveryQueueDetail([row], 8)
  assert.equal(detail, '8 upload attempts need review (showing 1): 2636: captions.vtt — source missing')
  assert.doesNotMatch(detail, /private|409|get_metadata/)
})
test('bounds the examples without hiding the total', () => {
  const detail = deliveryQueueDetail(Array(5).fill(row), 55)
  assert.match(detail, /55 upload attempts need review \(showing 3\)/)
  assert.equal(detail.split('2636:').length - 1, 3)
  assert.ok(detail.length < 300)
})
test('does not echo raw provider data or Slack mentions', () => {
  const detail = deliveryQueueDetail([{ ...row, last_error: 'secret https://example.test/token 404',
    payload: { safeName: '<@U123>', name: '<!channel>_captions.txt' } }], 1)
  assert.doesNotMatch(detail, /secret|https:|<!|<@/)
  assert.match(detail, /Unknown project.*Frame.io status unavailable/)
})
test('handles legacy/malformed payloads and healthy empty queues', () => {
  assert.match(deliveryQueueDetail([{ ...row, payload: null, last_error: null }], 1), /Unknown project/)
  assert.equal(deliveryQueueDetail([], 0), 'no dead-lettered events')
})
