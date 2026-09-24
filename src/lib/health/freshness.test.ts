/**
 * Cron-freshness unit tests (attempt vs success, startup grace, schedule-aware).
 *
 * Run: npx tsx --test src/lib/health/freshness.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkCronFreshness } from './probes'

const NOW = new Date('2026-07-15T20:00:00Z') // Wednesday, 13:00 PDT
const iso = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const minsAgo = (m: number) => iso(m * 60_000)
const find = (out: ReturnType<typeof checkCronFreshness>, key: string) => out.find((c) => c.key === key)!

describe('checkCronFreshness — interval crons', () => {
  it('is healthy when a cron succeeded within its window', () => {
    const out = checkCronFreshness({ 'delivery-dropbox-scan': minsAgo(5) }, NOW, {})
    assert.equal(find(out, 'cron:delivery-dropbox-scan').ok, true)
  })

  it('distinguishes "attempting but not succeeding" from "not running"', () => {
    const failing = checkCronFreshness(
      { 'dropbox-inbox-sweep': { success: minsAgo(120), attempt: minsAgo(2) } }, NOW, {},
    )
    const f = find(failing, 'cron:dropbox-inbox-sweep')
    assert.equal(f.ok, false)
    assert.match(String(f.detail), /attempting but not succeeding/)

    const dead = checkCronFreshness(
      { 'dropbox-inbox-sweep': { success: minsAgo(120), attempt: minsAgo(120) } }, NOW, {},
    )
    const d = find(dead, 'cron:dropbox-inbox-sweep')
    assert.equal(d.ok, false)
    assert.match(String(d.detail), /not running/)
  })

  it('treats a legacy string heartbeat as success-only', () => {
    const out = checkCronFreshness({ 'delivery-dropbox-scan': minsAgo(60) }, NOW, {})
    const c = find(out, 'cron:delivery-dropbox-scan')
    assert.equal(c.ok, false)
    assert.match(String(c.detail), /not running/) // no attempt recorded
  })
})

describe('checkCronFreshness — startup grace & never-seen', () => {
  it('holds a never-seen cron green inside startup grace', () => {
    const out = checkCronFreshness({}, NOW, {}, new Date(NOW.getTime() - 5 * 60_000))
    const c = find(out, 'cron:delivery-dropbox-scan')
    assert.equal(c.ok, true)
    assert.match(String(c.detail), /startup grace/)
  })

  it('fails closed for a never-seen interval cron once grace has elapsed', () => {
    const out = checkCronFreshness({}, NOW, {}, new Date(NOW.getTime() - 60 * 60_000))
    const c = find(out, 'cron:delivery-dropbox-scan')
    assert.equal(c.ok, false)
    assert.equal(c.detail, 'no heartbeat recorded')
  })
})

describe('checkCronFreshness — disabled features', () => {
  it('does not check a disabled transcript source', () => {
    const out = checkCronFreshness(
      { 'plaud-transcript-scan': minsAgo(10) }, NOW,
      { DRIVE_TRANSCRIPTS_ENABLED: 'false', PLAUD_INGEST_ENABLED: 'true' },
    )
    assert.equal(out.some((c) => c.key === 'cron:drive-transcript-scan'), false)
    assert.equal(find(out, 'cron:plaud-transcript-scan').ok, true)
  })

  it('does not check celebrations without a team channel', () => {
    const off = checkCronFreshness({}, NOW, {}, NOW)
    assert.equal(off.some((c) => c.key === 'cron:daily-celebrations'), false)
    const on = checkCronFreshness({}, NOW, { KIT_TEAM_CHANNEL_ID: 'C123' }, NOW)
    assert.equal(on.some((c) => c.key === 'cron:daily-celebrations'), true)
  })
})

describe('checkCronFreshness — schedule-aware weekday crons', () => {
  it('is healthy when it succeeded since today\'s 09:00 fire', () => {
    // Today's fire is 2026-07-15T16:00Z; a success at 16:05Z is after it.
    const success = new Date('2026-07-15T16:05:00Z').toISOString()
    const out = checkCronFreshness({ 'pending-checkin-nudge': { success, attempt: success } }, NOW, {})
    assert.equal(find(out, 'cron:pending-checkin-nudge').ok, true)
  })

  it('is stale when the last success predates today\'s fire and grace has passed', () => {
    // Success from the prior day; NOW (13:00 PDT) is well past 09:00 + 2h grace.
    const out = checkCronFreshness(
      { 'missing-time-scan': { success: '2026-07-14T16:05:00Z', attempt: null } }, NOW, {},
    )
    assert.equal(find(out, 'cron:missing-time-scan').ok, false)
  })

  it('stays green over the weekend when Friday\'s run succeeded', () => {
    // Saturday 2026-07-18 13:00 PDT; last fire was Friday 09:00 (16:00Z).
    const sat = new Date('2026-07-18T20:00:00Z')
    const friSuccess = new Date('2026-07-17T16:05:00Z').toISOString()
    const out = checkCronFreshness({ 'missing-time-scan': { success: friSuccess, attempt: friSuccess } }, sat, {})
    assert.equal(find(out, 'cron:missing-time-scan').ok, true)
  })

  it('stays green within grace even with a stale success (not yet due)', () => {
    // 09:30 PDT = 16:30Z, only 30m after the fire (grace 120m); an old success is fine.
    const justAfterFire = new Date('2026-07-15T16:30:00Z')
    const out = checkCronFreshness(
      { 'pending-checkin-nudge': { success: '2026-07-14T16:05:00Z', attempt: null } }, justAfterFire, {},
    )
    assert.equal(find(out, 'cron:pending-checkin-nudge').ok, true)
  })

  it('holds a never-seen weekday cron green while within grace of its fire', () => {
    // 09:30 PDT (16:30Z): today's fire was 30m ago, inside the 120m grace, and
    // nothing has stamped yet → "awaiting first scheduled run", not red.
    const withinGrace = new Date('2026-07-15T16:30:00Z')
    const green = find(checkCronFreshness({}, withinGrace, {}), 'cron:pending-checkin-nudge')
    assert.equal(green.ok, true)
    assert.match(String(green.detail), /awaiting first scheduled run/)

    // 13:00 PDT: same never-seen cron is now hours past fire+grace → flagged.
    const overdue = find(checkCronFreshness({}, NOW, {}), 'cron:pending-checkin-nudge')
    assert.equal(overdue.ok, false)
    assert.equal(overdue.detail, 'no heartbeat recorded')
  })
})
