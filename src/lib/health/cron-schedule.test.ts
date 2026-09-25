/**
 * Timezone / DST / weekend schedule-math tests.
 *
 * Run: npx tsx --test src/lib/health/cron-schedule.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tzOffsetMs, zonedTimeToUtc, mostRecentScheduledFire, type DailySpec } from './cron-schedule'

const LA = 'America/Los_Angeles'
const H = 3_600_000
const daily9 = (days?: number[]): DailySpec => ({
  kind: 'daily', label: 'x', hour: 9, minute: 0, tz: LA, days, graceMin: 120,
})

describe('tzOffsetMs', () => {
  it('is UTC-8 (PST) in winter and UTC-7 (PDT) in summer', () => {
    assert.equal(tzOffsetMs(new Date('2026-01-15T18:00:00Z'), LA), -8 * H)
    assert.equal(tzOffsetMs(new Date('2026-07-15T18:00:00Z'), LA), -7 * H)
  })
})

describe('zonedTimeToUtc', () => {
  it('maps 09:00 local to the right UTC instant across DST', () => {
    // Winter: 09:00 PST = 17:00Z. Summer: 09:00 PDT = 16:00Z.
    assert.equal(zonedTimeToUtc(2026, 1, 15, 9, 0, LA).toISOString(), '2026-01-15T17:00:00.000Z')
    assert.equal(zonedTimeToUtc(2026, 7, 15, 9, 0, LA).toISOString(), '2026-07-15T16:00:00.000Z')
  })
  it('handles the day after spring-forward (2026-03-08) as PDT', () => {
    assert.equal(zonedTimeToUtc(2026, 3, 9, 9, 0, LA).toISOString(), '2026-03-09T16:00:00.000Z')
    // The Saturday before is still PST.
    assert.equal(zonedTimeToUtc(2026, 3, 7, 9, 0, LA).toISOString(), '2026-03-07T17:00:00.000Z')
  })
})

describe('mostRecentScheduledFire', () => {
  it('returns today 09:00 when now is past it (summer)', () => {
    // 2026-07-15 is a Wednesday; 20:00Z = 13:00 PDT (after 09:00).
    const fire = mostRecentScheduledFire(daily9(), new Date('2026-07-15T20:00:00Z'))!
    assert.equal(fire.toISOString(), '2026-07-15T16:00:00.000Z')
  })
  it('returns yesterday 09:00 when now is before today 09:00', () => {
    // 15:00Z = 08:00 PDT (before 09:00) → Tuesday 2026-07-14.
    const fire = mostRecentScheduledFire(daily9(), new Date('2026-07-15T15:00:00Z'))!
    assert.equal(fire.toISOString(), '2026-07-14T16:00:00.000Z')
  })
  it('weekday-only: on Saturday, the last fire is Friday 09:00', () => {
    // 2026-07-18 is Saturday.
    const fire = mostRecentScheduledFire(daily9([1, 2, 3, 4, 5]), new Date('2026-07-18T20:00:00Z'))!
    assert.equal(fire.toISOString(), '2026-07-17T16:00:00.000Z')
  })
  it('weekday-only: on Sunday, the last fire is still Friday 09:00', () => {
    const fire = mostRecentScheduledFire(daily9([1, 2, 3, 4, 5]), new Date('2026-07-19T20:00:00Z'))!
    assert.equal(fire.toISOString(), '2026-07-17T16:00:00.000Z')
  })
  it('is DST-correct: Monday after spring-forward fires at 16:00Z (PDT), not 17:00Z', () => {
    // 2026-03-09 is the Monday after DST start (2026-03-08).
    const fire = mostRecentScheduledFire(daily9([1, 2, 3, 4, 5]), new Date('2026-03-09T20:00:00Z'))!
    assert.equal(fire.toISOString(), '2026-03-09T16:00:00.000Z')
  })
})
