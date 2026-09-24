/**
 * Railway cron liveness telemetry.
 *
 * The health watchdog (Vercel) reads `cron_heartbeats` and flags any tracked
 * cron whose newest success is older than its `CRON_MAX_AGE_MIN` allows. Until
 * now only the five Inngest/Vercel crons stamped a heartbeat, so a Railway
 * node-cron that silently stopped firing (the exact failure class that hid the
 * Dropbox outage for months) was invisible on `/status`.
 *
 * `stampCron` lets a Railway cron record a successful tick. It is best-effort by
 * contract: a heartbeat write must NEVER fail, delay, or throw into the cron
 * that called it, so every error is swallowed here. The id passed must match an
 * entry in `src/lib/health/probes.ts` (`CRON_MAX_AGE_MIN` + `CRON_LABELS`) for
 * the watchdog to surface its staleness.
 */

import { recordCronSuccess } from '../../src/lib/health/state'

export async function stampCron(cronId: string): Promise<void> {
  try {
    await recordCronSuccess(cronId)
  } catch (err) {
    // Never let telemetry break the job it is only observing.
    console.error(`[cron-heartbeat] ${cronId} stamp failed:`, (err as Error)?.message)
  }
}
