/**
 * Stale Frame.io delivery-transfer reconciler — DRAFT, DISABLED.
 *
 * NOT registered as any cron and NOT wired to a command. It exists so a future,
 * reviewed run can resolve rows orphaned in `processing` past the 24 h window —
 * but only under hard safety rules:
 *   - Skips projects with `frameio_upload_enabled = false` (e.g. 2639).
 *   - Skips explicitly retired rows (`retired_at is not null`, e.g. Fabric 2637).
 *   - VERIFIES live provider state before deciding any outcome — it never infers
 *     completion from age or project closure.
 *   - NEVER re-uploads and NEVER notifies producers. For unresolved/ambiguous
 *     rows it does nothing. The most it does is correct the ledger state
 *     (processing → ready when the provider is verifiably complete, or
 *     processing → failed when the asset is verifiably gone), with no side
 *     effects.
 *   - `dryRun` defaults TRUE and the whole thing is gated behind
 *     STALE_TRANSFER_RECONCILER_ENABLED.
 *
 * `verifyProvider` is a REQUIRED injected dependency (there is no default that
 * could guess): the real implementation performs a read-only Frame.io GET, which
 * is not available in the audit environment.
 */

export interface StaleTransferRow {
  id: string
  project_id: string | null
  state: string
  frameio_file_id: string | null
  dropbox_rev: string | null
  created_at: string
  retired_at: string | null
  frameio_upload_enabled: boolean // resolved from project_settings (default true)
}

/** Live provider truth for one asset. `null` = could not determine (unknown). */
export interface ProviderState {
  exists: boolean
  transcodeComplete: boolean
  hasShare: boolean
  /** true/false when both sizes are known; null when unknown. */
  sizeMatches: boolean | null
}

export type StaleOutcome = 'reconcile_ready' | 'mark_failed' | 'leave_unresolved'

export interface StaleDecision {
  id: string
  outcome: StaleOutcome
  reason: string
}

/**
 * PURE. Decide an outcome from the row + verified provider state. Conservative
 * by construction: only a fully-verified complete asset reconciles to ready,
 * only a verified-absent asset is failed, and anything unknown/partial is left
 * unresolved. Never returns "reupload" or "notify".
 */
export function decideStaleOutcome(row: StaleTransferRow, provider: ProviderState | null): StaleDecision {
  if (provider === null) {
    return { id: row.id, outcome: 'leave_unresolved', reason: 'provider state unknown — cannot decide safely' }
  }
  if (provider.exists && provider.transcodeComplete && provider.hasShare && provider.sizeMatches !== false) {
    return { id: row.id, outcome: 'reconcile_ready', reason: 'provider verified complete + shared (ledger correction only)' }
  }
  if (!provider.exists) {
    return { id: row.id, outcome: 'mark_failed', reason: 'provider asset does not exist (not delivered)' }
  }
  return { id: row.id, outcome: 'leave_unresolved', reason: 'provider still processing / share missing / size mismatch — unresolved' }
}

/** Rows that must be skipped before any provider call. PURE. */
export function isSkippable(row: StaleTransferRow): { skip: boolean; reason?: string } {
  if (row.retired_at) return { skip: true, reason: 'retired' }
  if (row.frameio_upload_enabled === false) return { skip: true, reason: 'project uploads disabled' }
  if (row.state !== 'processing') return { skip: true, reason: `state=${row.state} (not processing)` }
  return { skip: false }
}

// ── Gated IO layer ──

export interface ReconcilerClient {
  loadStaleProcessing(olderThanHours: number): Promise<StaleTransferRow[]>
  setTransferState(id: string, state: 'ready' | 'failed', note: string): Promise<void>
}

export interface ReconcileOptions {
  olderThanHours?: number
  dryRun?: boolean
  /** Required: read-only provider check. No default — must be supplied explicitly. */
  verifyProvider: (row: StaleTransferRow) => Promise<ProviderState | null>
  env?: Record<string, string | undefined>
}

export interface ReconcileResult {
  enabled: boolean
  dryRun: boolean
  scanned: number
  skipped: Array<{ id: string; reason: string }>
  decisions: StaleDecision[]
  applied: number
}

/**
 * DISABLED unless STALE_TRANSFER_RECONCILER_ENABLED === 'true'. Even when
 * enabled, `dryRun` defaults TRUE. Only ledger-state corrections are ever
 * applied; never an upload or a Slack notification.
 */
export async function reconcileStaleTransfers(
  client: ReconcilerClient, opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const env = opts.env ?? process.env
  const enabled = env.STALE_TRANSFER_RECONCILER_ENABLED === 'true'
  const dryRun = opts.dryRun !== false
  const result: ReconcileResult = { enabled, dryRun, scanned: 0, skipped: [], decisions: [], applied: 0 }
  if (!enabled) return result

  const rows = await client.loadStaleProcessing(opts.olderThanHours ?? 48)
  result.scanned = rows.length
  for (const row of rows) {
    const skip = isSkippable(row)
    if (skip.skip) { result.skipped.push({ id: row.id, reason: skip.reason! }); continue }
    const provider = await opts.verifyProvider(row) // read-only; never uploads
    const decision = decideStaleOutcome(row, provider)
    result.decisions.push(decision)
    if (dryRun || decision.outcome === 'leave_unresolved') continue
    // Ledger correction ONLY — no reupload, no producer notification.
    if (decision.outcome === 'reconcile_ready') await client.setTransferState(row.id, 'ready', decision.reason)
    else if (decision.outcome === 'mark_failed') await client.setTransferState(row.id, 'failed', decision.reason)
    result.applied++
  }
  return result
}
