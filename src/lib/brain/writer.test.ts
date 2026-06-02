/**
 * Brain Writer tests.
 *
 * Only the deterministic pieces are tested here: the classifier, the
 * sanitizer, and the auto-apply filter. The Haiku call itself isn't
 * unit-tested (requires API key + network); it's exercised in real
 * traffic.
 *
 * Run: npx tsx --test src/lib/brain/writer.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySignal,
  filterForAutoApply,
  type BrainSignal,
  type WriterResult,
} from './writer'

const baseSignal: BrainSignal = {
  kind: 'message',
  text: 'Final delivery is now June 22nd, slipped two days because of the VO re-record.',
  sourceRef: 'thread:C0123/p1718',
  author: 'U07ABC',
  occurredAt: '2026-06-01T14:30:00Z',
}

describe('classifySignal', () => {
  it('passes a substantive message', () => {
    assert.equal(classifySignal(baseSignal), null)
  })

  it('skips empty', () => {
    assert.equal(classifySignal({ ...baseSignal, text: '' }), 'empty')
  })

  it('skips too-short messages', () => {
    assert.equal(classifySignal({ ...baseSignal, text: 'ok cool' }), 'too_short')
  })

  it('skips long emoji-only', () => {
    assert.equal(
      classifySignal({ ...baseSignal, text: '👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍' }),
      'no_text_content',
    )
  })

  it('skips short reactions via too_short', () => {
    assert.equal(classifySignal({ ...baseSignal, text: 'thanks!' }), 'too_short')
    assert.equal(classifySignal({ ...baseSignal, text: 'lol' }), 'too_short')
    assert.equal(classifySignal({ ...baseSignal, text: 'nice one' }), 'too_short')
  })

  it('skips URL-only', () => {
    assert.equal(classifySignal({ ...baseSignal, text: 'https://example.com/foo/bar/baz' }), 'url_only')
  })

  it('skips channel events', () => {
    assert.equal(
      classifySignal({ ...baseSignal, text: '<@U07ABC> has joined the channel' }),
      'channel_event',
    )
  })

  it('does NOT skip a substantive mention-bearing message', () => {
    assert.equal(
      classifySignal({
        ...baseSignal,
        text: '<@U07ABC> can you confirm the delivery spec is ProRes 422 HQ at 1080p?',
      }),
      null,
    )
  })
})

describe('filterForAutoApply', () => {
  const result: WriterResult = {
    changes_understanding: true,
    patches: [
      {
        section: 'Operating context',
        operation: 'update',
        text: 'Delivery target: 2026-06-22 (slipped two days).',
        confidence: 0.92,
        match: 'delivery target',
      },
      {
        section: 'Recent decisions (log)',
        operation: 'add',
        text: 'Delivery slipped 2 days for VO re-record.',
        confidence: 0.85,
      },
      {
        section: 'Watchlist (deadlines & risks)',
        operation: 'add',
        text: 'Possible second slip if VO re-record runs over Friday.',
        confidence: 0.55, // low — should be filtered out
      },
    ],
  }

  it('applies high-confidence patches with provenance', () => {
    const filtered = filterForAutoApply({ result, signal: baseSignal })
    assert.equal(filtered.applied.length, 2)
    assert.equal(filtered.skipped_low_conf.length, 1)
    assert.deepEqual(filtered.applied[0].provenance, {
      src: 'thread:C0123/p1718',
      conf: 0.92,
      by: 'U07ABC',
    })
  })

  it('honors custom threshold', () => {
    const filtered = filterForAutoApply({ result, signal: baseSignal, threshold: 0.5 })
    assert.equal(filtered.applied.length, 3)
    assert.equal(filtered.skipped_low_conf.length, 0)
  })

  it('returns no applied patches when none cross threshold', () => {
    const lowOnly: WriterResult = {
      changes_understanding: true,
      patches: [{ section: 'Open decisions', operation: 'add', text: 'maybe X', confidence: 0.3 }],
    }
    const filtered = filterForAutoApply({ result: lowOnly, signal: baseSignal })
    assert.equal(filtered.applied.length, 0)
  })
})
