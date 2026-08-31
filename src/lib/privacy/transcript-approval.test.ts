import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isTranscriptApprovedForIngest } from './transcript-approval'

describe('transcript recording-level approval', () => {
  it('admits only explicitly prefixed recordings by default', () => {
    assert.equal(isTranscriptApprovedForIngest('[KIT] 2637 client kickoff', {}), true)
    assert.equal(isTranscriptApprovedForIngest('Private conversation', {}), false)
    assert.equal(isTranscriptApprovedForIngest(null, {}), false)
  })

  it('supports a configured prefix and fails closed on a blank prefix', () => {
    assert.equal(isTranscriptApprovedForIngest('APPROVED: project call', { TRANSCRIPT_APPROVAL_PREFIX: 'APPROVED:' }), true)
    assert.equal(isTranscriptApprovedForIngest('[KIT] project call', { TRANSCRIPT_APPROVAL_PREFIX: 'APPROVED:' }), false)
    assert.equal(isTranscriptApprovedForIngest('anything', { TRANSCRIPT_APPROVAL_PREFIX: '   ' }), false)
  })
})
