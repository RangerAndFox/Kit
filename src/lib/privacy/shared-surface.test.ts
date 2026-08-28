import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  containsSharedSurfaceSensitiveContent,
  guardSharedSlackReply,
  sanitizeTranscriptForSharedSurface,
  SHARED_CHANNEL_PRIVACY_REPLY,
} from './shared-surface'

describe('shared-surface privacy boundary', () => {
  it('detects financials, client contact details, credentials, contracts, and private material', () => {
    for (const value of [
      'The budget is 35,000 dollars.',
      'Email tara@example.com with feedback.',
      'Call the client at 313-555-0199.',
      'The API key is in the notes.',
      'This is a confidential personal matter.',
      'The SOW includes two review rounds.',
    ]) assert.equal(containsSharedSurfaceSensitiveContent(value), true, value)
    assert.equal(containsSharedSurfaceSensitiveContent('The next review is Tuesday afternoon.'), false)
  })

  it('removes sensitive transcript lines and anonymizes speaker names', () => {
    const safe = sanitizeTranscriptForSharedSurface([
      '[00:01] Tara Nadolny: The review is Tuesday at 2.',
      '[00:08] Steve: Budget is $25,000.',
      '[00:12] Tara Nadolny: Email me at tara@example.com.',
      '[00:18] Steve: Boardomatic V2 is the next milestone.',
    ].join('\n'))
    assert.equal(safe, '[00:01] Speaker: The review is Tuesday at 2.\n[00:18] Speaker: Boardomatic V2 is the next milestone.')
    assert.equal(safe.includes('Tara'), false)
    assert.equal(safe.includes('$25,000'), false)
  })

  it('blocks sensitive final Slack output even if an upstream model ignored instructions', () => {
    assert.equal(guardSharedSlackReply('The client budget is $25,000.'), SHARED_CHANNEL_PRIVACY_REPLY)
    assert.equal(guardSharedSlackReply('The next review is Tuesday.'), 'The next review is Tuesday.')
  })
})
