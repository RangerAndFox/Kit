import { describe, it, expect } from 'vitest'

import { isLocalCheckinHour } from '../src/checkins/daily-hours'

describe('isLocalCheckinHour', () => {
  it('fires for Eastern at 5pm EDT while Pacific and Central wait', () => {
    const t = new Date('2026-07-08T21:00:00Z') // 5pm EDT, 4pm CDT, 2pm PDT
    expect(isLocalCheckinHour(t, 'America/New_York')).toBe(true)
    expect(isLocalCheckinHour(t, 'America/Chicago')).toBe(false)
    expect(isLocalCheckinHour(t, 'America/Los_Angeles')).toBe(false)
  })

  it('fires for Central an hour later', () => {
    const t = new Date('2026-07-08T22:00:00Z') // 5pm CDT
    expect(isLocalCheckinHour(t, 'America/Chicago')).toBe(true)
    expect(isLocalCheckinHour(t, 'America/New_York')).toBe(false)
  })

  it('fires for Pacific at 5pm PDT (UTC has rolled to the next day)', () => {
    const t = new Date('2026-07-09T00:00:00Z') // 5pm PDT Jul 8
    expect(isLocalCheckinHour(t, 'America/Los_Angeles')).toBe(true)
    expect(isLocalCheckinHour(t, 'America/New_York')).toBe(false) // 8pm
  })

  it('tracks DST — winter Eastern is UTC-5', () => {
    const winter = new Date('2026-12-09T22:00:00Z') // 5pm EST
    expect(isLocalCheckinHour(winter, 'America/New_York')).toBe(true)
    expect(isLocalCheckinHour(winter, 'America/Chicago')).toBe(false) // 4pm CST
  })

  it('respects a custom hour', () => {
    const t = new Date('2026-07-08T13:00:00Z') // 9am EDT
    expect(isLocalCheckinHour(t, 'America/New_York', 9)).toBe(true)
  })
})
