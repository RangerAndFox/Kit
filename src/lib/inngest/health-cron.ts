/**
 * Health watchdog — Inngest cron.
 *
 * Every 10 min: run all health checks, compare against the last recorded
 * state, and post to the ops channel ONLY when something flips (down or
 * recovered). Persists the new state so a persistent outage alerts once, not
 * every tick. This is the piece that would have paged us the day Dropbox's
 * token went missing instead of three months later.
 *
 * Alert delivery is part of the state transition. If delivery fails, the
 * previous state remains unchanged so the next run retries the transition.
 */

import { inngest } from './client'
import { runAllChecks } from '../health/run'
import { healthRecipient, reportHealth } from '../health/report-store'

export const healthWatchdog = inngest.createFunction(
  {
    id: 'health-watchdog',
    name: 'Health — watchdog + alerts',
    retries: 1,
    concurrency: { limit: 1, key: "'kit-health-reporting'", scope: 'env' },
    triggers: [{ cron: '*/10 * * * *' }],
  },
  async ({ step, runId }) => {
    const snapshot = await step.run('health-snapshot-v2', async () => {
      const observed_at = new Date().toISOString()
      return { observed_at, checks: await runAllChecks() }
    })
    // Keep enqueue, pending-plan delivery and atomic state commit in ONE shared
    // concurrency step; Inngest concurrency serializes steps, not whole runs.
    await step.run('publish-health-report', () => reportHealth({
      id: `watchdog:${runId}`, recipient: healthRecipient(), ...snapshot,
    }))

    return {
      checked: snapshot.checks.length,
      down: snapshot.checks.filter((r) => !r.ok && !r.unknown).map((r) => r.key),
      unknown: snapshot.checks.filter((r) => r.unknown).map((r) => r.key),
    }
  },
)
