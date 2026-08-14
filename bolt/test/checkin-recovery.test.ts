import { describe, it, expect } from 'vitest'

import {
  extractReplyBurst,
  validateEntries,
  type PlannedEntry,
  type SlackMessageLike,
} from '../src/checkins/recovery'

/** Build a message at `minutes` past a fixed base ts. */
const BASE = 1_785_000_000
const at = (minutes: number, over: Partial<SlackMessageLike> = {}): SlackMessageLike => ({
  ts: String(BASE + minutes * 60),
  user: 'U_ME',
  text: 'hours',
  ...over,
})

describe('extractReplyBurst', () => {
  it('returns null when the user never replied', () => {
    expect(extractReplyBurst([], 'U_ME')).toBe(null)
    expect(
      extractReplyBurst([at(1, { user: 'U_OTHER' }), at(2, { bot_id: 'B1', user: undefined })], 'U_ME'),
    ).toBe(null)
  })

  it('joins consecutive lines of one answer', () => {
    const burst = extractReplyBurst(
      [at(0, { text: '4h on Rayfin' }), at(2, { text: '2h on 2611' })],
      'U_ME',
    )
    expect(burst?.text).toBe('4h on Rayfin\n2h on 2611')
    expect(burst?.messageCount).toBe(2)
    expect(burst?.excludedCount).toBe(0)
  })

  // The production defect: a wide search window (needed, because people reply
  // late) also swept in the NEXT day's answer, so one check-in logged another
  // day's hours. Only the first contiguous burst may be taken.
  it('excludes a later reply that belongs to a different check-in', () => {
    const burst = extractReplyBurst(
      [
        at(0, { text: '2 hours #2631, 6 hours misc' }), // the reply to THIS check-in
        at(60 * 24 * 10, { text: '2h on 2637, 2h on 2631, 1h on 2636, 3h on Misc' }), // 10 days later
      ],
      'U_ME',
    )
    expect(burst?.text).toBe('2 hours #2631, 6 hours misc')
    expect(burst?.messageCount).toBe(1)
    expect(burst?.excludedCount).toBe(1)
  })

  it('ends the burst at the configured gap', () => {
    const msgs = [at(0, { text: 'first' }), at(45, { text: 'much later' })]
    expect(extractReplyBurst(msgs, 'U_ME', { burstGapMinutes: 30 })?.text).toBe('first')
    expect(extractReplyBurst(msgs, 'U_ME', { burstGapMinutes: 60 })?.text).toBe('first\nmuch later')
  })

  it('sorts newest-first input and skips bots, subtypes, and empty text', () => {
    const burst = extractReplyBurst(
      [
        at(3, { text: 'and 2h misc' }),
        at(2, { bot_id: 'B1', user: undefined, text: 'Kit says hi' }),
        at(1, { subtype: 'channel_join', text: 'joined' }),
        at(1.5, { text: '   ' }),
        at(0, { text: '6h Rayfin' }),
      ],
      'U_ME',
    )
    expect(burst?.text).toBe('6h Rayfin\nand 2h misc')
    expect(burst?.ts).toBe(String(BASE))
  })
})

describe('validateEntries', () => {
  const ok = (over: Partial<PlannedEntry> = {}): PlannedEntry => ({
    hours: 2,
    spentDate: '2026-08-10',
    projectQuery: '2631',
    resolution: 'matched',
    harvest_project_id: 48797463,
    harvest_project_name: 'Power vNext Launch',
    ...over,
  })

  it('accepts a normal day', () => {
    const r = validateEntries([ok(), ok({ hours: 6, projectQuery: 'misc', harvest_project_id: 1 })])
    expect(r.ok).toBe(true)
    expect(r.problems).toEqual([])
    expect(r.totalHours).toBe(8)
  })

  it('rejects an empty set', () => {
    expect(validateEntries([]).ok).toBe(false)
  })

  it('rejects unresolved projects', () => {
    const r = validateEntries([ok({ resolution: 'unmatched', harvest_project_id: undefined, projectQuery: 'coffee' })])
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toContain('coffee')
  })

  // The ~25h and ~60h days a hallucinated parse produced.
  it('rejects a day total above the single-day limit', () => {
    const r = validateEntries([ok({ hours: 12 }), ok({ hours: 13, harvest_project_id: 2 })])
    expect(r.ok).toBe(false)
    expect(r.problems.join(' ')).toContain('exceeds')
    expect(r.totalHours).toBe(25)
  })

  // The verbatim-repeated (project, hours) pairs in the corrupted write.
  it('rejects duplicate entries unless explicitly allowed', () => {
    const dupes = [ok(), ok()]
    expect(validateEntries(dupes).ok).toBe(false)
    expect(validateEntries(dupes).problems.join(' ')).toContain('duplicate')
    expect(validateEntries(dupes, { allowDuplicates: true }).ok).toBe(true)
  })

  it('rejects non-positive or non-numeric hours', () => {
    expect(validateEntries([ok({ hours: 0 })]).ok).toBe(false)
    expect(validateEntries([ok({ hours: -3 })]).ok).toBe(false)
    expect(validateEntries([ok({ hours: Number.NaN })]).ok).toBe(false)
  })
})
