import { describe, it, expect } from 'vitest'

import { coversDate, expandRanges } from '../../src/lib/staff/time-off'
import { computeMissingStreak } from '../src/checkins/missing-time'

describe('coversDate (inclusive range)', () => {
  const r = { start_date: '2026-08-03', end_date: '2026-08-07' }

  it('includes both endpoints', () => {
    expect(coversDate(r, '2026-08-03')).toBe(true)
    expect(coversDate(r, '2026-08-07')).toBe(true)
  })

  it('excludes the days either side', () => {
    expect(coversDate(r, '2026-08-02')).toBe(false)
    expect(coversDate(r, '2026-08-08')).toBe(false)
  })

  it('handles a single-day range', () => {
    const one = { start_date: '2026-08-04', end_date: '2026-08-04' }
    expect(coversDate(one, '2026-08-04')).toBe(true)
    expect(coversDate(one, '2026-08-05')).toBe(false)
  })
})

describe('expandRanges', () => {
  it('expands an inclusive range to every day', () => {
    const days = expandRanges(
      [{ start_date: '2026-08-03', end_date: '2026-08-07' }],
      '2026-08-01',
      '2026-08-31',
    )
    expect([...days].sort()).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
    ])
  })

  it('clips to the requested window', () => {
    const days = expandRanges(
      [{ start_date: '2026-07-28', end_date: '2026-08-05' }],
      '2026-08-01',
      '2026-08-03',
    )
    expect([...days].sort()).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
  })

  it('ignores ranges outside the window and merges overlapping ones', () => {
    const days = expandRanges(
      [
        { start_date: '2026-01-01', end_date: '2026-01-02' }, // far outside
        { start_date: '2026-08-03', end_date: '2026-08-04' },
        { start_date: '2026-08-04', end_date: '2026-08-05' }, // overlaps
      ],
      '2026-08-01',
      '2026-08-31',
    )
    expect([...days].sort()).toEqual(['2026-08-03', '2026-08-04', '2026-08-05'])
  })

  it('crosses a month boundary and a DST change without skipping a day', () => {
    const days = expandRanges(
      [{ start_date: '2026-10-31', end_date: '2026-11-02' }],
      '2026-10-01',
      '2026-11-30',
    )
    expect([...days].sort()).toEqual(['2026-10-31', '2026-11-01', '2026-11-02'])
  })

  it('returns empty for malformed input or an inverted window', () => {
    expect(expandRanges([], '2026-08-01', '2026-08-05').size).toBe(0)
    expect(expandRanges([{ start_date: null, end_date: null } as any], '2026-08-01', '2026-08-05').size).toBe(0)
    expect(expandRanges([{ start_date: '2026-08-03', end_date: '2026-08-04' }], '2026-08-05', '2026-08-01').size).toBe(0)
  })
})

describe('computeMissingStreak with time off', () => {
  const tz = 'America/Los_Angeles'
  const empty = new Set<string>()

  // Ted's case: out Mon 8/3 – Fri 8/7 with nothing logged. Before time-off
  // awareness this was a 5-working-day "missing time" streak flagged to every
  // producer.
  it('does not count approved time off as missing', () => {
    const timeOff = new Set([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
    ])
    const missing = computeMissingStreak({
      through: '2026-08-07',
      loggedDates: empty,
      skippedDates: empty,
      timeOffDates: timeOff,
      tz,
      lookbackDays: 5,
    })
    expect(missing).toEqual([])
  })

  it('still reports a genuine gap on either side of the time off', () => {
    // Off Wed 8/5 only; nothing logged Thu 8/6 or Fri 8/7 → those two count,
    // and the walk continues PAST the day off rather than stopping there.
    const missing = computeMissingStreak({
      through: '2026-08-07',
      loggedDates: empty,
      skippedDates: empty,
      timeOffDates: new Set(['2026-08-05']),
      tz,
      lookbackDays: 5,
    })
    expect(missing).toContain('2026-08-07')
    expect(missing).toContain('2026-08-06')
    expect(missing).toContain('2026-08-04')
    expect(missing).not.toContain('2026-08-05')
  })

  it('behaves as before when no time off is supplied', () => {
    const missing = computeMissingStreak({
      through: '2026-08-07',
      loggedDates: new Set(['2026-08-06']),
      skippedDates: empty,
      tz,
      lookbackDays: 5,
    })
    expect(missing).toEqual(['2026-08-07']) // stops at the logged day
  })
})
