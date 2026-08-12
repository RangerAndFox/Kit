// @ts-nocheck
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
 * Recipient defaults to the owner's Slack id and is overridable via
 * KIT_HEALTH_DIGEST_USER_ID. Silent no-op if SLACK_BOT_TOKEN is unset — the
 * checks still run, so nothing else regresses.
 */

import { inngest } from './client'
import { runAllChecks } from '../health/run'
import { loadRecentCheckins, studioToday, studioDateLabel } from '../health/checkins-digest'
import { summarizeCheckins, unavailableCheckinSummary, formatHealthDigest } from '../health/digest'
import { postSlackAsKit } from '../health/notify'

// Steve (rangerandfox) — the "only me" recipient. Overridable without a deploy.
const DEFAULT_RECIPIENT = 'U4CA7HXT9'

export const healthDailyDigest = inngest.createFunction(
  {
    id: 'health-daily-digest',
    name: 'Health — daily digest DM',
    retries: 1,
    triggers: [{ cron: 'TZ=America/New_York 0 9 * * *' }],
  },
  async ({ step }) => {
    const recipient = process.env.KIT_HEALTH_DIGEST_USER_ID || DEFAULT_RECIPIENT

    const checks = await step.run('run-checks', () => runAllChecks())
    // Distinguish "no backlog" from "couldn't read the backlog": a swallowed
    // query error must not render as a healthy zero (a fabricated all-clear for
    // the very failure class this digest exists to catch).
    const loaded = await step.run('load-checkins', async () => {
      try {
        return { ok: true, rows: await loadRecentCheckins() }
      } catch (err) {
        return { ok: false, rows: [], error: String(err?.message || err) }
      }
    })

    const now = new Date()
    const summary = loaded.ok ? summarizeCheckins(loaded.rows, studioToday(now)) : unavailableCheckinSummary()
    const text = formatHealthDigest(checks, summary, studioDateLabel(now))

    const sent = await step.run('dm', () => postSlackAsKit(recipient, text))

    return {
      recipient,
      sent,
      down: checks.filter((c) => !c.ok).map((c) => c.key),
      checkinsUnavailable: summary.unavailable,
      repliedUnlogged: summary.repliedUnlogged,
      failed: summary.failed,
      stuckLogging: summary.stuckLogging,
    }
  },
)
