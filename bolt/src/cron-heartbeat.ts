/**
 * Railway cron liveness telemetry.
 *
 * The health watchdog (Vercel) reads `cron_heartbeats` and flags any tracked
 * cron whose success is stale for its schedule (the failure class that hid the
 * Dropbox outage for months). Railway crons now stamp two signals:
 *
 *   stampCronAttempt(id) — the tick STARTED, whatever its outcome.
 *   stampCronSuccess(id) — the pass COMPLETED successfully.
 *
 * The split lets the watchdog distinguish "running but failing" (fresh attempt,
 * stale success) from "not running at all". Both are best-effort by contract: a
 * heartbeat write must NEVER throw into or fail the job it observes; each write
 * has a two-second deadline and errors are swallowed here.
 *
 * TRUTHFULNESS RULE: only call stampCronSuccess where the job's own work has
 * actually completed — never after a wrapper (an inner `.catch`, `allSettled`)
 * that would resolve even when the pass threw. Per-item failures the job
 * deliberately swallows and tallies are not cron failures; an infra-level throw
 * (a failed initial query, etc.) rejects the job's promise and must skip the
 * success stamp. Ids must match `getCronSpecs` in `src/lib/health/cron-specs.ts`.
 */

import { recordCronAttempt, recordCronSuccess, registerCronSchedules } from '../../src/lib/health/state'

export async function registerRailwayCronSchedules(): Promise<void> {
  try { await registerCronSchedules('railway') }
  catch { console.error('[cron-heartbeat] Railway schedule registration failed') }
}

export async function stampCronAttempt(cronId: string): Promise<void> {
  try {
    await recordCronAttempt(cronId)
  } catch (err) {
    console.error(`[cron-heartbeat] ${cronId} attempt stamp failed:`, (err as Error)?.message)
  }
}

export async function stampCronSuccess(cronId: string): Promise<void> {
  try {
    await recordCronSuccess(cronId)
  } catch (err) {
    console.error(`[cron-heartbeat] ${cronId} success stamp failed:`, (err as Error)?.message)
  }
}
