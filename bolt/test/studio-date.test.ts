import { describe, it, expect } from 'vitest'

import { studioToday, studioDateMinusDays } from '../../src/lib/time/studio-date'

describe('studioToday', () => {
  it('stays on the studio calendar day after 5pm Pacific (UTC has rolled over)', () => {
    // Mon Jul 6 2026, 5:30pm PDT == Tue Jul 7 2026, 00:30 UTC
    const eveningPT = new Date('2026-07-07T00:30:00Z')
    expect(studioToday(eveningPT, 'America/Los_Angeles')).toBe('2026-07-06')
  })

  it('matches UTC during the studio afternoon', () => {
    // Mon Jul 6 2026, 1:00pm PDT == 20:00 UTC same day
    const afternoonPT = new Date('2026-07-06T20:00:00Z')
    expect(studioToday(afternoonPT, 'America/Los_Angeles')).toBe('2026-07-06')
  })

  it('handles winter (PST) offsets too', () => {
    // Mon Dec 7 2026, 6:00pm PST == Tue Dec 8, 02:00 UTC
    const winterEvening = new Date('2026-12-08T02:00:00Z')
    expect(studioToday(winterEvening, 'America/Los_Angeles')).toBe('2026-12-07')
  })
})

describe('studioDateMinusDays', () => {
  it('computes "yesterday" from the studio calendar day, not UTC', () => {
    const eveningPT = new Date('2026-07-07T00:30:00Z') // still Jul 6 in LA
    expect(studioDateMinusDays(1, eveningPT, 'America/Los_Angeles')).toBe('2026-07-05')
  })

  it('crosses month boundaries', () => {
    const d = new Date('2026-07-01T20:00:00Z')
    expect(studioDateMinusDays(1, d, 'America/Los_Angeles')).toBe('2026-06-30')
  })
})
