/**
 * Daily health digest — pure roll-up + formatting tests.
 *
 * Run: npx tsx --test src/lib/health/digest.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  summarizeCheckins,
  checkinsUrgent,
  formatHealthDigest,
  unavailableCheckinSummary,
  type CheckinRow,
  type CheckinSummary,
} from './digest'
import type { CheckResult } from './diff'

const TODAY = '2026-08-12'
const row = (over: Partial<CheckinRow>): CheckinRow => ({
  check_in_date: '2026-08-10',
  status: 'logged',
  reply_ts: null,
  harvest_entry_ids: [123],
  ...over,
})

const allGreenChecks: CheckResult[] = [
  { key: 'dropbox', label: 'Dropbox', ok: true, detail: '10ms' },
  { key: 'harvest', label: 'Harvest', ok: true, detail: '20ms' },
  { key: 'supabase', label: 'Supabase', ok: true, detail: '5ms' },
  { key: 'cron:delivery-dropbox-scan', label: 'Delivery queue scan', ok: true, detail: '0m' },
  { key: 'cron:pre-meeting-scan', label: 'Meeting briefings scan', ok: true, detail: '3m' },
]

const emptySummary: CheckinSummary = summarizeCheckins([], TODAY)

describe('summarizeCheckins', () => {
  it('counts a replied-but-unlogged past day as lost hours (not sent-no-reply)', () => {
    const s = summarizeCheckins(
      [row({ check_in_date: '2026-08-05', status: 'parsed', reply_ts: '123.45', harvest_entry_ids: null })],
      TODAY,
    )
    assert.equal(s.repliedUnlogged, 1)
    assert.equal(s.sentNoReply, 0)
    assert.equal(s.oldestUnlogged, '2026-08-05')
  })

  it('an unanswered past-day DM is sent-no-reply (soft), not lost hours', () => {
    const s = summarizeCheckins([row({ status: 'sent', reply_ts: null, harvest_entry_ids: null })], TODAY)
    assert.equal(s.repliedUnlogged, 0)
    assert.equal(s.sentNoReply, 1)
  })

  it('flags the migration-048 signatures: failed, stuck-in-logging, logged-without-ids', () => {
    const s = summarizeCheckins(
      [
        row({ status: 'failed', harvest_entry_ids: null }),
        row({ status: 'logging', harvest_entry_ids: null }),
        row({ status: 'logged', harvest_entry_ids: null }),
        row({ status: 'logged', harvest_entry_ids: [] }),
      ],
      TODAY,
    )
    assert.equal(s.failed, 1)
    assert.equal(s.stuckLogging, 1)
    assert.equal(s.loggedWithoutIds, 2)
    assert.equal(checkinsUrgent(s), true)
  })

  it('flags a Harvest id present but status never advanced (inconsistency)', () => {
    const s = summarizeCheckins([row({ status: 'parsed', harvest_entry_ids: [999] })], TODAY)
    assert.equal(s.harvestIdButStuck, 1)
    assert.equal(checkinsUrgent(s), true)
  })

  it('a partial-failure row (status=failed WITH Harvest ids) counts once as failed, not also as stuck', () => {
    // confirm.ts logs matched entries and fails the rest, writing the succeeded
    // ids on a 'failed' row — a known, already-explained shape, not the anomaly.
    const s = summarizeCheckins([row({ status: 'failed', harvest_entry_ids: [555] })], TODAY)
    assert.equal(s.failed, 1)
    assert.equal(s.harvestIdButStuck, 0)
  })

  it('a past-day failed row with a reply counts once as failed, not also as backlog', () => {
    // confirm.ts only reaches 'failed' after a reply, so reply_ts is set; the
    // row is reported by s.failed and must not also inflate repliedUnlogged.
    const s = summarizeCheckins(
      [row({ check_in_date: '2026-08-05', status: 'failed', reply_ts: '1.2', harvest_entry_ids: null })],
      TODAY,
    )
    assert.equal(s.failed, 1)
    assert.equal(s.repliedUnlogged, 0)
    assert.equal(s.oldestUnlogged, null)
  })

  it('counts only today rows toward loggedToday and treats today as not-past', () => {
    const s = summarizeCheckins(
      [
        row({ check_in_date: TODAY, status: 'logged' }),
        row({ check_in_date: TODAY, status: 'sent', reply_ts: null, harvest_entry_ids: null }),
      ],
      TODAY,
    )
    assert.equal(s.loggedToday, 1)
    assert.equal(s.sentNoReply, 0) // today's unanswered DM is the day in progress, not a backlog
    assert.equal(checkinsUrgent(s), false)
  })

  it('a skipped past day is terminal — never counted as backlog', () => {
    const s = summarizeCheckins([row({ status: 'skipped', reply_ts: '1.2', harvest_entry_ids: null })], TODAY)
    assert.equal(s.repliedUnlogged, 0)
  })

  it('a reopened past-day row (status=sent WITH a stale reply_ts) is sent-no-reply, not lost hours', () => {
    // reply.ts reopen() reverts a non-hours/unparseable reply to 'sent'; an
    // open status is unanswered regardless of a leftover reply_ts stamp.
    const s = summarizeCheckins(
      [row({ check_in_date: '2026-08-05', status: 'sent', reply_ts: '1.2', harvest_entry_ids: null })],
      TODAY,
    )
    assert.equal(s.repliedUnlogged, 0)
    assert.equal(s.sentNoReply, 1)
    assert.equal(s.oldestUnlogged, null)
  })
})

describe('formatHealthDigest', () => {
  it('all green → "all systems go" and a clean time-logging line', () => {
    const s = summarizeCheckins([row({ check_in_date: TODAY, status: 'logged' })], TODAY)
    const msg = formatHealthDigest(allGreenChecks, s, 'Tue Aug 12')
    assert.match(msg, /all systems go/)
    assert.match(msg, /Integrations:.*all up/)
    assert.match(msg, /\*Crons:\* 2\/2 fresh/)
    assert.match(msg, /Time logging:.*1 logged today, no replies waiting/)
    assert.doesNotMatch(msg, /rotating_light/)
  })

  it('a down integration is listed and counts toward the issue header', () => {
    const checks = allGreenChecks.map((c) => (c.key === 'dropbox' ? { ...c, ok: false, detail: '401 unauthorized' } : c))
    const msg = formatHealthDigest(checks, emptySummary, 'Tue Aug 12')
    assert.match(msg, /1 issue\b/)
    assert.match(msg, /:red_circle: \*Dropbox\* — 401 unauthorized/)
  })

  it('urgent time-logging state escalates the header even when integrations are green', () => {
    const s = summarizeCheckins([row({ status: 'logging', harvest_entry_ids: null })], TODAY)
    const msg = formatHealthDigest(allGreenChecks, s, 'Tue Aug 12')
    assert.match(msg, /1 issue\b/)
    assert.match(msg, /Time logging:.*migration-048 signature/)
  })

  it('unavailable check-in data escalates the header and never reads as a clean zero', () => {
    const msg = formatHealthDigest(allGreenChecks, unavailableCheckinSummary(), 'Tue Aug 12')
    assert.equal(checkinsUrgent(unavailableCheckinSummary()), true)
    assert.match(msg, /1 issue\b/)
    assert.match(msg, /Time logging:.*could not be read/)
    assert.doesNotMatch(msg, /all systems go/)
    assert.doesNotMatch(msg, /no replies waiting/)
  })

  it('a non-urgent backlog shows a warning but does not raise the issue count', () => {
    const s = summarizeCheckins(
      [row({ check_in_date: '2026-08-05', status: 'parsed', reply_ts: '1.2', harvest_entry_ids: null })],
      TODAY,
    )
    const msg = formatHealthDigest(allGreenChecks, s, 'Tue Aug 12')
    assert.match(msg, /all systems go/) // integrations + crons green → still "go"
    assert.match(msg, /:warning: 1 past-day reply still unlogged \(oldest 2026-08-05\)/)
  })
})
