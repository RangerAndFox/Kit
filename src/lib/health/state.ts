// @ts-nocheck
/**
 * Supabase I/O for the health monitor: last-known status (for alert de-dup +
 * "down since" timing) and cron heartbeats (for freshness).
 *
 * Tables (migration 052): system_health, cron_heartbeats. RLS-on with no
 * policies — service role only.
 */

import { createAdminClient } from '../supabase/admin'
import type { CheckResult, Status } from './diff'

export interface HealthRow {
  key: string
  status: Status
  detail: string | null
  since: string
}

/** Current stored status per check key, for the transition diff. */
export async function loadHealthRows(): Promise<HealthRow[]> {
  const { data, error } = await createAdminClient()
    .from('system_health')
    .select('key, status, detail, since')
  if (error) throw new Error(`loadHealthRows: ${error.message}`)
  return (data as HealthRow[]) || []
}

export function statusMap(rows: HealthRow[]): Record<string, Status> {
  const m: Record<string, Status> = {}
  for (const r of rows) m[r.key] = r.status
  return m
}

/**
 * Persist the latest results. `since` is preserved when a check's status is
 * unchanged and reset to now when it flips, so alerts can say how long
 * something's been down / how long it was out.
 */
export async function saveHealthState(
  results: CheckResult[],
  prev: HealthRow[],
  now: Date = new Date(),
): Promise<void> {
  const prevByKey = new Map(prev.map((r) => [r.key, r]))
  const nowIso = now.toISOString()
  const rows = results.map((r) => {
    const status: Status = r.ok ? 'up' : 'down'
    const before = prevByKey.get(r.key)
    const since = before && before.status === status ? before.since : nowIso
    return { key: r.key, status, detail: r.detail ?? null, since, checked_at: nowIso }
  })
  const { error } = await createAdminClient()
    .from('system_health')
    .upsert(rows, { onConflict: 'key' })
  if (error) throw new Error(`saveHealthState: ${error.message}`)
}

/** Newest success timestamp per cron id (ISO), for checkCronFreshness. */
export async function loadHeartbeats(): Promise<Record<string, string>> {
  const { data, error } = await createAdminClient()
    .from('cron_heartbeats')
    .select('cron_id, last_success_at')
  if (error) throw new Error(`loadHeartbeats: ${error.message}`)
  const out: Record<string, string> = {}
  for (const row of data || []) out[row.cron_id] = row.last_success_at
  return out
}

/**
 * Stamp a cron's successful completion. Best-effort: a heartbeat write must
 * never fail the cron that called it, so callers swallow errors.
 */
export async function recordCronSuccess(cronId: string, now: Date = new Date()): Promise<void> {
  const { error } = await createAdminClient()
    .from('cron_heartbeats')
    .upsert({ cron_id: cronId, last_success_at: now.toISOString() }, { onConflict: 'cron_id' })
  if (error) throw new Error(`recordCronSuccess(${cronId}): ${error.message}`)
}
