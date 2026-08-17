import { describe, it, expect } from 'vitest'

import { localHourAt } from '../src/checkins/daily-hours'

describe('localHourAt', () => {
  it('fires for Eastern at 5pm EDT while Pacific and Central wait', () => {
    const t = new Date('2026-07-08T21:00:00Z') // 5pm EDT, 4pm CDT, 2pm PDT
    expect(localHourAt(t, 'America/New_York')).toBe(17)
    expect(localHourAt(t, 'America/Chicago')).toBe(16)
    expect(localHourAt(t, 'America/Los_Angeles')).toBe(14)
  })

  it('fires for Central an hour later', () => {
    const t = new Date('2026-07-08T22:00:00Z') // 5pm CDT
    expect(localHourAt(t, 'America/Chicago')).toBe(17)
    expect(localHourAt(t, 'America/New_York')).toBe(18)
  })

  it('fires for Pacific at 5pm PDT (UTC has rolled to the next day)', () => {
    const t = new Date('2026-07-09T00:00:00Z') // 5pm PDT Jul 8
    expect(localHourAt(t, 'America/Los_Angeles')).toBe(17)
    expect(localHourAt(t, 'America/New_York')).toBe(20)
  })

  it('tracks DST — winter Eastern is UTC-5', () => {
    const winter = new Date('2026-12-09T22:00:00Z') // 5pm EST
    expect(localHourAt(winter, 'America/New_York')).toBe(17)
    expect(localHourAt(winter, 'America/Chicago')).toBe(16)
  })
})
