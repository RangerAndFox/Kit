import { describe, it, expect } from 'vitest'

import {
  checkinToday,
  checkinDateMinusDays,
  checkinTimezone,
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
