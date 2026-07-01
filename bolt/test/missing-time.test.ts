import { describe, it, expect } from 'vitest'

import { computeMissingStreak, buildFlagText } from '../src/checkins/missing-time'
import { isWorkday, ymdAddDays } from '../src/checkins/date'

const TZ = 'America/Los_Angeles'

describe('isWorkday / ymdAddDays', () => {
  it('ymdAddDays shifts calendar days and crosses months', () => {
    expect(ymdAddDays('2026-06-25', -1)).toBe('2026-06-24')
    expect(ymdAddDays('2026-07-01', -1)).toBe('2026-06-30')
    expect(ymdAddDays('2026-06-25', 3)).toBe('2026-06-28')
  })

  it('isWorkday is true Mon–Fri, false on the weekend', () => {
    // 2026-06-26 is a Friday, 27 Sat, 28 Sun, 29 Mon.
    expect(isWorkday('2026-06-26', TZ)).toBe(true)
    expect(isWorkday('2026-06-27', TZ)).toBe(false)
    expect(isWorkday('2026-06-28', TZ)).toBe(false)
    expect(isWorkday('2026-06-29', TZ)).toBe(true)
  })
})

describe('computeMissingStreak', () => {
  const opts = (logged: string[], skipped: string[] = []) => ({
    through: '2026-06-25', // Thursday
    loggedDates: new Set(logged),
    skippedDates: new Set(skipped),
    tz: TZ,
  })

  it('counts consecutive missing working days back from `through`', () => {
    // Nothing logged → Thu 25, Wed 24, Tue 23, Mon 22 are missing (4),
    // then Sat/Sun skipped by the workday filter, then Fri 19...
    const missing = computeMissingStreak(opts([]))
    expect(missing.slice(0, 4)).toEqual(['2026-06-25', '2026-06-24', '2026-06-23', '2026-06-22'])
  })

  it('stops at the most recent logged working day', () => {
    // Logged Wed the 24th → only Thu 25 is missing.
    const missing = computeMissingStreak(opts(['2026-06-24']))
    expect(missing).toEqual(['2026-06-25'])
  })

  it('skips weekends without breaking the streak', () => {
    // through = Mon 2026-06-29; nothing logged. Mon 29 missing, then Sun/Sat
    // skipped, Fri 26 missing, Thu 25 missing → streak spans the weekend.
    const missing = computeMissingStreak({
      through: '2026-06-29',
      loggedDates: new Set<string>(),
      skippedDates: new Set<string>(),
      tz: TZ,
    })
    expect(missing.slice(0, 3)).toEqual(['2026-06-29', '2026-06-26', '2026-06-25'])
  })

  it('treats an explicitly skipped (PTO) day as a stop, not a miss', () => {
    // Tue 23 marked skipped → streak is just Thu 25, Wed 24.
    const missing = computeMissingStreak(opts([], ['2026-06-23']))
    expect(missing).toEqual(['2026-06-25', '2026-06-24'])
  })

  it('returns empty when the most recent working day is logged', () => {
    expect(computeMissingStreak(opts(['2026-06-25']))).toEqual([])
  })
})

describe('buildFlagText', () => {
  it('mentions the user, the day count, the date range, and last-logged', () => {
    const text = buildFlagText({
      slackUserId: 'U123',
      fullName: 'Alice Smith',
      missing: ['2026-06-25', '2026-06-24', '2026-06-23'], // newest-first
      lastLogged: '2026-06-22',
    })
    expect(text).toContain('<@U123>')
    expect(text).toContain('3 working days')
    // Range renders earliest → latest.
    expect(text).toContain('Jun 23')
    expect(text).toContain('Jun 25')
    expect(text).toMatch(/Last logged: .*Jun 22/)
  })

  it('handles the never-logged case', () => {
    const text = buildFlagText({
      slackUserId: 'U1',
      fullName: null,
      missing: ['2026-06-25'],
      lastLogged: null,
    })
    expect(text).toMatch(/No logged time/i)
    expect(text).toContain('1 working days')
  })
})
