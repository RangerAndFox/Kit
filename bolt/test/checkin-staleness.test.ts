import { describe, it, expect } from 'vitest'

import {
  CHECKIN_STALE_AFTER_DAYS,
  ymdDaysBetween,
  ymdAddDays,
} from '../src/checkins/date'

describe('ymdDaysBetween', () => {
  it('counts whole days forward', () => {
    expect(ymdDaysBetween('2026-08-01', '2026-08-01')).toBe(0)
    expect(ymdDaysBetween('2026-08-01', '2026-08-02')).toBe(1)
    expect(ymdDaysBetween('2026-07-12', '2026-08-13')).toBe(32)
  })

  it('is negative when the second date is earlier', () => {
    expect(ymdDaysBetween('2026-08-13', '2026-08-01')).toBe(-12)
  })

  it('crosses month and year boundaries', () => {
    expect(ymdDaysBetween('2026-01-31', '2026-02-01')).toBe(1)
    expect(ymdDaysBetween('2025-12-31', '2026-01-01')).toBe(1)
  })

  // Anchored at UTC noon, so a DST transition can't round to 0 or 2.
  it('is exact across a DST transition', () => {
    expect(ymdDaysBetween('2026-03-07', '2026-03-09')).toBe(2)
    expect(ymdDaysBetween('2026-10-31', '2026-11-02')).toBe(2)
  })

  it('returns 0 for unparseable input rather than NaN', () => {
    expect(ymdDaysBetween('nonsense', '2026-08-01')).toBe(0)
    expect(ymdDaysBetween('2026-08-01', '')).toBe(0)
  })
})

describe('confirmation staleness window', () => {
  const today = '2026-08-13'

  it('treats a same-day or recent card as actionable', () => {
    expect(ymdDaysBetween(today, today)).toBeLessThanOrEqual(CHECKIN_STALE_AFTER_DAYS)
    const recent = ymdAddDays(today, -3)
    expect(ymdDaysBetween(recent, today)).toBeLessThanOrEqual(CHECKIN_STALE_AFTER_DAYS)
  })

  it('holds the boundary day inside the window', () => {
    const edge = ymdAddDays(today, -CHECKIN_STALE_AFTER_DAYS)
    expect(ymdDaysBetween(edge, today)).toBe(CHECKIN_STALE_AFTER_DAYS)
    expect(ymdDaysBetween(edge, today) > CHECKIN_STALE_AFTER_DAYS).toBe(false)
  })

  // The real cases found in production: cards from 2026-07-12..07-24 still
  // carried live "Confirm & log" buttons weeks later.
  it('marks a month-old card stale', () => {
    expect(ymdDaysBetween('2026-07-12', today) > CHECKIN_STALE_AFTER_DAYS).toBe(true)
    expect(ymdDaysBetween('2026-07-24', today) > CHECKIN_STALE_AFTER_DAYS).toBe(true)
  })
})
