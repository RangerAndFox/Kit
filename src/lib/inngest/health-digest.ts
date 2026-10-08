/**
 * Daily health digest — Inngest cron.
 *
 * Once a day at 09:00 America/New_York, run the same health checks the watchdog
 * and /status use, roll up the time-logging state, and DM a one-glance digest
 * to the studio owner from Kit's bot. Unlike the watchdog (which alerts only on
 * a flip), this always sends — a green "all systems go" is the signal that the
 * check actually ran, and a quietly growing unlogged-hours backlog surfaces
 * before it becomes the migration-048 incident again.
 *
 * Recipient uses the shared private KIT_HEALTH_CHANNEL_ID, falling back to
 * KIT_HEALTH_DIGEST_USER_ID/the owner. Silent no-op if SLACK_BOT_TOKEN is unset — the
 * checks still run, so nothing else regresses.
 */

import { inngest } from './client'
import { runAllChecks } from '../health/run'
import { loadRecentCheckins, reconcileParsedCheckins } from '../health/checkins-digest'
import { summarizeCheckins, unavailableCheckinSummary } from '../health/digest'
import { studioToday, studioDateLabel } from '../time/studio-date'
import { healthRecipient, reportHealth } from '../health/report-store'

export const healthDailyDigest = inngest.createFunction(
  {
    id: 'health-daily-digest',
    name: 'Health — daily digest DM',
    retries: 1,
    concurrency: { limit: 1, key: "'kit-health-reporting'", scope: 'env' },
    triggers: [{ cron: 'TZ=America/New_York 0 9 * * *' }],
  },
  async ({ step, runId }) => {
    const recipient = healthRecipient()

    const snapshot = await step.run('health-snapshot-v2', async () => {
      const observed_at = new Date().toISOString()
      return { observed_at, checks: await runAllChecks() }
    })
    // Acquire the run's date before reconciliation so retries make the same
    // expiry decision and render against the same studio day.
    const now = new Date(await step.run('now', () => Date.now()))
    const today = studioToday(now)
    const reconciliation = await step.run('reconcile-checkins', () => reconcileParsedCheckins(today))
    // Distinguish "no backlog" from "couldn't read the backlog": a swallowed
    // query error must not render as a healthy zero (a fabricated all-clear for
    // the very failure class this digest exists to catch).
    const loaded = await step.run('load-checkins', async () => {
      try {
        return { ok: true, rows: await loadRecentCheckins() }
      } catch (err) {
        return { ok: false, rows: [] as Awaited<ReturnType<typeof loadRecentCheckins>>, error: err instanceof Error ? err.message : String(err) }
      }
    })

    // Memoize wall-clock time in a step so a retry classifies the (memoized)
    // rows against the same day boundary the original attempt used, not the
    // retry's clock — the canonical Inngest idiom for acquiring time.
    const summary = loaded.ok ? summarizeCheckins(loaded.rows, today) : unavailableCheckinSummary()

    // Delivery IS the heartbeat, so a dropped DM must not report green.
    // A configured-but-failed send throws → the step's retries:1 engages for a
    // transient blip, and a persistent failure (revoked token, stale recipient)
    // surfaces as a red Inngest run instead of a silent success. No token is a
    // deliberate no-op (the digest is simply not wired up), not a failure.
    const delivery = await step.run('publish-health-report', async () => {
      if (!process.env.SLACK_BOT_TOKEN) return 'no-token'
      await reportHealth({ id: `digest:${runId}`, recipient, ...snapshot,
        digest: { summary, dateLabel: studioDateLabel(now) } })
      return 'sent'
    })

    return {
      recipient,
      delivery,
      down: snapshot.checks.filter((c) => !c.ok && !c.unknown).map((c) => c.key),
      unknown: snapshot.checks.filter((c) => c.unknown).map((c) => c.key),
      checkinsUnavailable: summary.unavailable,
      repliedUnlogged: summary.repliedUnlogged,
      failed: summary.failed,
      stuckLogging: summary.stuckLogging,
      reconciliation,
    }
  },
)
