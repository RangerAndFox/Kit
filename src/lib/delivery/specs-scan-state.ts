/**
 * Durable state + exclusive lease for the "Delivery — Per-project specs/ folder
 * scan" Inngest cron (table: delivery_specs_scan_state, migration 059).
 *
 * This is the specs scan's OWN cursor + lease — deliberately separate from
 * Bolt's `dropbox_state.singleton` (a different table and owner) so the two
 * Dropbox watchers never advance each other's cursor (invariant 10).
 *
 * Exclusivity is a compare-and-set lease on the single state row, mirroring the
 * Project Control workbook lease (`src/lib/project-control/store.ts`):
 *   - `claimSpecsScanLease` succeeds only when the lease is free/expired and
 *     bumps a monotonic `fence`;
 *   - cursor advances are holder+fence conditional, so a stale run reclaimed
 *     after a pause cannot clobber the new holder;
 *   - the lease expires on its own, so a crashed run self-recovers next tick.
 *
 * The generated `Database` type predates migration 059, so DB access goes
 * through a narrow typed facade (`SupabaseLike`) until types are regenerated —
 * same approach as project-control/store.ts. Every public function stays typed.
 */

import { createAdminClient } from '../supabase/admin'

const ROW_ID = 'singleton'
/**
 * Lease lifetime. Must exceed one invocation's elapsed budget (see
 * specs-watcher SCAN_TIME_BUDGET_MS ~45s) so a live run keeps the lease for its
 * whole tick, yet be short enough that a crashed run is reclaimable soon.
 */
const LEASE_MS = 4 * 60 * 1000

const nowIso = (now = Date.now()) => new Date(now).toISOString()

export type SpecsScanPhase = 'bootstrap' | 'delta'

export interface SpecsScanState {
  id: string
  phase: SpecsScanPhase
  cursor: string | null
  lease_holder: string | null
  lease_expires_at: string | null
  fence: number
  updated_at: string
}

// ─── Narrow Supabase facade (table not yet in generated types) ───────────────

interface QueryResult {
  data: unknown
  error: { message: string } | null
}
interface FilterBuilder extends PromiseLike<QueryResult> {
  select(cols?: string): FilterBuilder
  eq(col: string, val: unknown): FilterBuilder
  or(filter: string): FilterBuilder
  maybeSingle(): Promise<QueryResult>
}
interface TableBuilder {
  select(cols?: string): FilterBuilder
  update(values: Record<string, unknown>): FilterBuilder
  upsert(values: Record<string, unknown>, opts?: Record<string, unknown>): FilterBuilder
}
interface SupabaseLike {
  from(table: string): TableBuilder
}

let clientFactory: () => unknown = createAdminClient

/** Test seam: swap the Supabase client factory for a fake. Pass null to restore. */
export function __setSpecsScanStateClientForTests(f: (() => unknown) | null): void {
  clientFactory = f || createAdminClient
}

function db(): SupabaseLike {
  return clientFactory() as unknown as SupabaseLike
}

async function ensureRow(): Promise<void> {
  await db()
    .from('delivery_specs_scan_state')
    .upsert({ id: ROW_ID }, { onConflict: 'id', ignoreDuplicates: true })
}

/** Read the singleton state row, creating it if missing. Throws on DB error. */
export async function getSpecsScanState(): Promise<SpecsScanState> {
  await ensureRow()
  const { data, error } = await db()
    .from('delivery_specs_scan_state')
    .select('*')
    .eq('id', ROW_ID)
    .maybeSingle()
  if (error) throw new Error(`getSpecsScanState: ${error.message}`)
  const row = (data as Partial<SpecsScanState>) || {}
  return {
    id: ROW_ID,
    phase: (row.phase as SpecsScanPhase) || 'bootstrap',
    cursor: row.cursor ?? null,
    lease_holder: row.lease_holder ?? null,
    lease_expires_at: row.lease_expires_at ?? null,
    fence: Number(row.fence ?? 0),
    updated_at: row.updated_at ?? nowIso(),
  }
}

export interface LeaseClaim {
  ok: boolean
  /** Granted fence token to pass to advanceSpecsScanCursor; null when not claimed. */
  fence: number | null
}

/**
 * Compare-and-set claim: succeed only when the lease is null/expired. Bumps the
 * fence monotonically so a reclaim fences out the previous holder. A contending
 * run gets ok=false and must exit (as skipped) without touching the cursor.
 */
export async function claimSpecsScanLease(holder: string, now = Date.now()): Promise<LeaseClaim> {
  await ensureRow()
  const current = await getSpecsScanState()
  const nextFence = Number(current.fence ?? 0) + 1
  const nowStr = nowIso(now)
  const { data, error } = await db()
    .from('delivery_specs_scan_state')
    .update({
      lease_holder: holder,
      lease_expires_at: nowIso(now + LEASE_MS),
      fence: nextFence,
      updated_at: nowStr,
    })
    .eq('id', ROW_ID)
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowStr}`)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`claimSpecsScanLease: ${error.message}`)
  return { ok: !!data, fence: data ? nextFence : null }
}

/**
 * Advance the cursor / phase — CONDITIONAL on still holding the lease at the
 * granted fence. Also renews the lease expiry (progress = heartbeat), so a long
 * multi-page tick keeps ownership. Returns false when the lease was lost (a
 * newer holder reclaimed it): the caller must stop processing immediately.
 */
export async function advanceSpecsScanCursor(
  holder: string,
  fence: number,
  patch: { cursor: string | null; phase: SpecsScanPhase },
  now = Date.now(),
): Promise<boolean> {
  const { data, error } = await db()
    .from('delivery_specs_scan_state')
    .update({
      cursor: patch.cursor,
      phase: patch.phase,
      lease_expires_at: nowIso(now + LEASE_MS),
      updated_at: nowIso(now),
    })
    .eq('id', ROW_ID)
    .eq('lease_holder', holder)
    .eq('fence', fence)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`advanceSpecsScanCursor: ${error.message}`)
  return !!data
}

/**
 * Ownership-safe release: clears the lease ONLY when the stored holder still
 * matches. A run whose lease already expired and was reclaimed cannot release
 * the new holder's lease.
 */
export async function releaseSpecsScanLease(holder: string, now = Date.now()): Promise<void> {
  const { error } = await db()
    .from('delivery_specs_scan_state')
    .update({ lease_holder: null, lease_expires_at: null, updated_at: nowIso(now) })
    .eq('id', ROW_ID)
    .eq('lease_holder', holder)
  if (error) throw new Error(`releaseSpecsScanLease: ${error.message}`)
}
