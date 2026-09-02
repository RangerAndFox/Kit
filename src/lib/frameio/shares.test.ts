import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { newestFrameioProjectShare, normalizeFrameioProjectShare } from './shares'

describe('Frame.io project shares', () => {
  it('normalizes the v4 URL variants', () => {
    assert.deepEqual(normalizeFrameioProjectShare({
      id: 'share-1', name: 'Boardomatic V1', short_url: 'https://f.io/abc', created_at: '2026-07-06T12:00:00Z',
    }), {
      id: 'share-1', name: 'Boardomatic V1', url: 'https://f.io/abc', createdAt: '2026-07-06T12:00:00Z',
    })
    assert.equal(normalizeFrameioProjectShare({ id: 'share-2', name: 'Missing URL' }), null)
  })

  it('selects the newest valid share by creation time', () => {
    assert.equal(newestFrameioProjectShare([
      { id: 'older', name: 'V1', url: 'https://f.io/1', created_at: '2026-06-30T12:00:00Z' },
      { id: 'newer', name: 'V2', share_url: 'https://f.io/2', inserted_at: '2026-07-06T12:00:00Z' },
    ])?.id, 'newer')
  })
})
