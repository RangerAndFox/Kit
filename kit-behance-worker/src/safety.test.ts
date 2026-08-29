import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isPublishLabel, isPublishMutation } from './safety.js'

describe('Behance publish lockout', () => {
  it('recognizes public publish controls but not draft save controls', () => {
    assert.equal(isPublishLabel('Publish'), true)
    assert.equal(isPublishLabel('Save & Publish'), true)
    assert.equal(isPublishLabel('Save as Draft'), false)
    assert.equal(isPublishLabel('Save'), false)
  })

  it('blocks publish mutations and allows ordinary draft saves', () => {
    const request = (method: string, url: string, body = '') => ({ method: () => method, url: () => url, postData: () => body }) as any
    assert.equal(isPublishMutation(request('POST', 'https://www.behance.net/api/project/publish')), true)
    assert.equal(isPublishMutation(request('PATCH', 'https://www.behance.net/api/project/12', '{"status":"published"}')), true)
    assert.equal(isPublishMutation(request('POST', 'https://www.behance.net/api/project/12/save', '{"status":"draft"}')), false)
    assert.equal(isPublishMutation(request('GET', 'https://www.behance.net/publish')), false)
  })
})
