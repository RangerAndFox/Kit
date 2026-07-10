import { describe, it, expect } from 'vitest'

import {
  checkinToday,
  checkinDateMinusDays,
  checkinTimezone,
  resolveSpentDate,
  resolveDayPhrase,
  formatShortDate,
  studioHolidays,
  isWorkday,
} from '../src/checkins/date'

describe('checkin date helpers', () => {
  // 2026-06-26T00:30:00Z is 2026-06-25 17:30 in Los Angeles (PDT, UTC-7).
  // This is the exact moment the 5pm Pacific cron fires — the day must still
  // read as the 25th, not the 26th.
  const fivePmPacific = new Date('2026-06-26T00:30:00Z')

  it('checkinToday uses the studio timezone, not UTC', () => {
    expect(checkinToday(fivePmPacific, 'America/Los_Angeles')).toBe('2026-06-25')
    // For contrast: a naive UTC derivation would (wrongly) say the 26th.
    expect(fivePmPacific.toISOString().split('T')[0]).toBe('2026-06-26')
  })

  it('checkinToday respects an explicit non-Pacific timezone', () => {
    expect(checkinToday(fivePmPacific, 'UTC')).toBe('2026-06-26')
    // New York is UTC-4 in June → 20:30 on the 25th.
    expect(checkinToday(fivePmPacific, 'America/New_York')).toBe('2026-06-25')
  })

  it('checkinDateMinusDays(7) is the local date a week back', () => {
    expect(checkinDateMinusDays(7, fivePmPacific, 'America/Los_Angeles')).toBe('2026-06-18')
  })

  it('checkinDateMinusDays handles month boundaries', () => {
    const earlyJuly = new Date('2026-07-02T10:00:00Z') // 03:00 PDT, still the 2nd
    expect(checkinDateMinusDays(5, earlyJuly, 'America/Los_Angeles')).toBe('2026-06-27')
  })

  it('checkinTimezone defaults to Los Angeles, honors the env override', () => {
    const prev = process.env.CHECKIN_TIMEZONE
    delete process.env.CHECKIN_TIMEZONE
    expect(checkinTimezone()).toBe('America/Los_Angeles')
    process.env.CHECKIN_TIMEZONE = 'America/New_York'
    expect(checkinTimezone()).toBe('America/New_York')
    if (prev === undefined) delete process.env.CHECKIN_TIMEZONE
    else process.env.CHECKIN_TIMEZONE = prev
  })
})

describe('resolveSpentDate', () => {
  const anchor = '2026-06-25'

  it('accepts a valid recent past date (e.g. "yesterday")', () => {
    expect(resolveSpentDate('2026-06-24', anchor)).toBe('2026-06-24')
    expect(resolveSpentDate('2026-06-20', anchor)).toBe('2026-06-20')
  })

  it('keeps the anchor when the date is null/empty/malformed', () => {
    expect(resolveSpentDate(null, anchor)).toBe(anchor)
    expect(resolveSpentDate(undefined, anchor)).toBe(anchor)
    expect(resolveSpentDate('yesterday', anchor)).toBe(anchor)
    expect(resolveSpentDate('2026-13-40', anchor)).toBe(anchor)
  })

  it('rejects future dates (no future-dating Harvest time)', () => {
    expect(resolveSpentDate('2026-06-26', anchor)).toBe(anchor)
  })

  it('rejects dates more than ~2 weeks back as likely misparses', () => {
    expect(resolveSpentDate('2026-06-10', anchor)).toBe(anchor)
    // exactly 14 days back is still allowed
    expect(resolveSpentDate('2026-06-11', anchor)).toBe('2026-06-11')
  })
})

describe('resolveDayPhrase', () => {
  // 2026-07-09 is a Thursday.
  const anchor = '2026-07-09'

  it('resolves weekday names to the most recent past occurrence (incl. today)', () => {
    expect(resolveDayPhrase('monday', anchor)).toBe('2026-07-06')
    expect(resolveDayPhrase('tuesday', anchor)).toBe('2026-07-07')
    expect(resolveDayPhrase('wednesday', anchor)).toBe('2026-07-08')
    expect(resolveDayPhrase('thursday', anchor)).toBe('2026-07-09') // today
    expect(resolveDayPhrase('friday', anchor)).toBe('2026-07-03') // last week's Fri
  })

  it('handles abbreviations, "on"/"last" prefixes, and casing', () => {
    expect(resolveDayPhrase('Mon', anchor)).toBe('2026-07-06')
    expect(resolveDayPhrase('on Tuesday', anchor)).toBe('2026-07-07')
    expect(resolveDayPhrase('tues', anchor)).toBe('2026-07-07')
    // "last thursday" is the prior week, not today
    expect(resolveDayPhrase('last thursday', anchor)).toBe('2026-07-02')
  })

  it('handles relative phrases', () => {
    expect(resolveDayPhrase('today', anchor)).toBe('2026-07-09')
    expect(resolveDayPhrase('yesterday', anchor)).toBe('2026-07-08')
    expect(resolveDayPhrase('2 days ago', anchor)).toBe('2026-07-07')
  })

  it('handles month/day in words and numbers, picking the past occurrence', () => {
    expect(resolveDayPhrase('July 6', anchor)).toBe('2026-07-06')
    expect(resolveDayPhrase('6 July', anchor)).toBe('2026-07-06')
    expect(resolveDayPhrase('7/6', anchor)).toBe('2026-07-06')
    // A month/day later in the year resolves to last year, not the future.
    expect(resolveDayPhrase('December 25', anchor)).toBe('2025-12-25')
  })

  it('passes ISO dates through and returns null for anything unrecognized', () => {
    expect(resolveDayPhrase('2026-07-06', anchor)).toBe('2026-07-06')
    expect(resolveDayPhrase(null, anchor)).toBeNull()
    expect(resolveDayPhrase('', anchor)).toBeNull()
    expect(resolveDayPhrase('whenever', anchor)).toBeNull()
  })

  it('chains with resolveSpentDate for the full guard (multi-day backfill)', () => {
    // Thu anchor, "monday" 3 days back — within the 14-day window, kept.
    expect(resolveSpentDate(resolveDayPhrase('monday', anchor), anchor)).toBe('2026-07-06')
    // Unrecognized phrase → null → falls back to the anchor day.
    expect(resolveSpentDate(resolveDayPhrase('whenever', anchor), anchor)).toBe(anchor)
  })
})

describe('formatShortDate', () => {
  it('renders a friendly weekday/month/day in the studio tz', () => {
    expect(formatShortDate('2026-06-24', 'America/Los_Angeles')).toBe('Wed, Jun 24')
  })
})

describe('studio holidays', () => {
  it('computes 2026 fixed and floating US holidays', () => {
    const set = studioHolidays(2026)
    expect(set.has('2026-01-01')).toBe(true) // New Year's (Thursday)
    expect(set.has('2026-01-19')).toBe(true) // MLK Day (3rd Monday)
    expect(set.has('2026-05-25')).toBe(true) // Memorial Day (last Monday)
    expect(set.has('2026-06-19')).toBe(true) // Juneteenth (Friday)
    expect(set.has('2026-07-03')).toBe(true) // July 4 observed (Sat → Fri)
    expect(set.has('2026-09-07')).toBe(true) // Labor Day
    expect(set.has('2026-11-26')).toBe(true) // Thanksgiving (4th Thursday)
    expect(set.has('2026-11-27')).toBe(true) // Day after Thanksgiving
    expect(set.has('2026-12-25')).toBe(true) // Christmas (Friday)
  })

  it('isWorkday is false on holidays and weekends, true on normal weekdays', () => {
    expect(isWorkday('2026-07-03')).toBe(false) // observed July 4
    expect(isWorkday('2026-07-04')).toBe(false) // Saturday anyway
    expect(isWorkday('2026-11-26')).toBe(false) // Thanksgiving
    expect(isWorkday('2026-07-01')).toBe(true) // ordinary Wednesday
  })

  it('honors STUDIO_HOLIDAYS env overrides', () => {
    process.env.STUDIO_HOLIDAYS = '2026-07-06'
    expect(isWorkday('2026-07-06')).toBe(false) // one-off studio closure
    delete process.env.STUDIO_HOLIDAYS
    expect(isWorkday('2026-07-06')).toBe(true)
  })
})
