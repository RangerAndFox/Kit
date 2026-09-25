/**
 * Supabase I/O for the health monitor: last-known status (for alert de-dup +
 * "down since" timing) and cron heartbeats (for freshness).
 *
 * Tables (migration 052): system_health, cron_heartbeats. RLS-on with no
 * policies — service role only.
 */

import { createAdminClient } from '../supabase/admin'
import type { CheckResult, Status } from './diff'
import { cronDefinition, getCronSpecs, parseRegistration, type CronRegistration } from './cron-specs'
import type { Json } from '../../types/supabase'

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

export interface HeartbeatState {
  registration?: CronRegistration
  /** Newest successful completion (ISO), or null if it has attempted but never succeeded. */
  success: string | null
  /** Newest tick start (ISO), or null. Distinguishes "failing" from "not running". */
  attempt: string | null
}

/** Newest attempt + success timestamp per cron id, for checkCronFreshness. */
export async function loadHeartbeats(): Promise<Record<string, HeartbeatState>> {
  const { data, error } = await createAdminClient()
    .from('cron_heartbeats')
    .select('cron_id, last_success_at, last_attempt_at, owner_runtime, enabled, schedule, enrolled_at')
    .abortSignal(AbortSignal.timeout(3000))
  if (error) throw new Error(`loadHeartbeats: ${error.message}`)
  const out: Record<string, HeartbeatState> = {}
  for (const row of data || []) {
    if (row.cron_id.startsWith('__')) continue // reserved rows (e.g. the monitor epoch) are not crons
    out[row.cron_id] = {
      success: row.last_success_at ?? null,
      attempt: row.last_attempt_at ?? null,
      registration: parseRegistration(row.cron_id, row),
    }
  }
  return out
}

/**
 * Reserved heartbeat id holding the PERSISTENT monitoring epoch — the first
 * time the watchdog ever ran. Startup grace is measured from this, NOT from a
 * per-process boot time, so a Vercel cold start cannot reset the grace window
 * and mask a Railway worker that has been stale the whole time. Insert-once
 * (ON CONFLICT DO NOTHING); its timestamp never moves after the first write.
 */
export const MONITOR_EPOCH_ID = '__monitor_epoch__'

/**
 * Return the persistent monitoring epoch, initializing it once if absent.
 * Best-effort: on any error returns null, and the caller then applies NO
 * startup grace (fails toward actionable) rather than a fresh, resettable one.
 */
export async function getOrInitMonitorEpoch(now: Date = new Date()): Promise<Date | null> {
  const sb = createAdminClient()
  const existing = await sb
    .from('cron_heartbeats')
    .select('last_success_at')
    .eq('cron_id', MONITOR_EPOCH_ID)
    .abortSignal(AbortSignal.timeout(2000))
    .maybeSingle()
  if (existing.error) throw new Error(`getOrInitMonitorEpoch read: ${existing.error.message}`)
  if (existing.data?.last_success_at) return new Date(existing.data.last_success_at)
  // Absent → set it once. ignoreDuplicates makes a concurrent init a no-op.
  const iso = now.toISOString()
  const inserted = await sb
    .from('cron_heartbeats')
    .upsert({ cron_id: MONITOR_EPOCH_ID, last_success_at: iso }, { onConflict: 'cron_id', ignoreDuplicates: true })
    .select('last_success_at')
    .abortSignal(AbortSignal.timeout(2000))
    .maybeSingle()
  if (inserted.error) throw new Error(`getOrInitMonitorEpoch init: ${inserted.error.message}`)
  // If a racing writer won, re-read to get the persisted value.
  if (inserted.data?.last_success_at) return new Date(inserted.data.last_success_at)
  const reread = await sb
    .from('cron_heartbeats')
    .select('last_success_at')
    .eq('cron_id', MONITOR_EPOCH_ID)
    .abortSignal(AbortSignal.timeout(2000))
    .maybeSingle()
  if (reread.error) throw new Error(`getOrInitMonitorEpoch reread: ${reread.error.message}`)
  return reread.data?.last_success_at ? new Date(reread.data.last_success_at) : null
}

/**
 * Stamp that a cron TICK STARTED (an attempt), independent of outcome. Records
 * only `last_attempt_at`; a brand-new row's `last_success_at` stays null so an
 * attempt is never mistaken for a success. Best-effort — callers swallow errors.
 */
async function writeCron(cronId: string, kind: 'register' | 'attempt' | 'success'): Promise<void> {
  const definition = cronDefinition(cronId)
  if (!definition) throw new Error('Unknown cron id')
  const { error } = await createAdminClient().rpc('record_kit_cron', {
    p_cron_id: cronId, p_runtime: definition.owner, p_enabled: definition.enabled,
    p_schedule: definition.schedule as Json, p_kind: kind,
  }).abortSignal(AbortSignal.timeout(2000))
  if (error) throw new Error('Cron telemetry unavailable: ' + error.message)
}
export async function registerCronSchedules(owner: 'railway' | 'vercel'): Promise<void> {
  // Preview dashboards may share a production database; they must not publish
  // their environment's flags over the production watchdog registration.
  if (owner === 'vercel' && process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') return
  await Promise.all(Object.keys(getCronSpecs()).filter(id => cronDefinition(id)?.owner === owner)
    .map(id => writeCron(id, 'register')))
}
export async function recordCronAttempt(cronId: string): Promise<void> {
  await writeCron(cronId, 'attempt')
}
export async function recordCronSuccess(cronId: string): Promise<void> {
  await writeCron(cronId, 'success')
}
