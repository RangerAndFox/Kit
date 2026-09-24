/**
 * Cron-freshness unit tests.
 *
 * Run: npx tsx --test src/lib/health/freshness.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkCronFreshness } from './probes'

const NOW = new Date('2026-07-13T12:00:00Z')
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

describe('checkCronFreshness', () => {
  it('is healthy when a cron ran within its window', () => {
    const out = checkCronFreshness(
      { 'drive-transcript-scan': minsAgo(10) },
      NOW,
      { DRIVE_TRANSCRIPTS_ENABLED: 'true' },
    )
    const t = out.find((c) => c.key === 'cron:drive-transcript-scan')!
    assert.strictEqual(t.ok, true)
  })

  it('flags a cron stale past its max age', () => {
    const out = checkCronFreshness({ 'delivery-dropbox-scan': minsAgo(30) }, NOW)
    const t = out.find((c) => c.key === 'cron:delivery-dropbox-scan')!
    assert.strictEqual(t.ok, false)
    assert.match(String(t.detail), /no success in 30m/)
  })

  it('fails closed when no successful heartbeat has ever been recorded', () => {
    const out = checkCronFreshness({}, NOW)
    assert.ok(out.every((c) => !c.ok))
    assert.strictEqual(out[0].detail, 'no successful heartbeat recorded')
  })

  it('tracks Railway node-cron liveness (previously unmonitored)', () => {
    // A silently-stalled Railway cron must now surface on /status.
    const stale = checkCronFreshness({ 'dropbox-inbox-sweep': minsAgo(30) }, NOW)
    const drain = stale.find((c) => c.key === 'cron:dropbox-inbox-sweep')!
    assert.strictEqual(drain.ok, false)
    assert.match(String(drain.detail), /no success in 30m/)

    const fresh = checkCronFreshness({ 'project-control-recovery': minsAgo(5) }, NOW)
    assert.strictEqual(fresh.find((c) => c.key === 'cron:project-control-recovery')!.ok, true)
  })

  it('does not report a disabled transcript source as stale after cutover', () => {
    const out = checkCronFreshness(
      {
        'drive-transcript-scan': minsAgo(120),
        'plaud-transcript-scan': minsAgo(10),
      },
      NOW,
      { DRIVE_TRANSCRIPTS_ENABLED: 'false', PLAUD_INGEST_ENABLED: 'true' },
    )
    assert.equal(out.some((c) => c.key === 'cron:drive-transcript-scan'), false)
    assert.equal(out.find((c) => c.key === 'cron:plaud-transcript-scan')?.ok, true)
  })
})
