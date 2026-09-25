/**
 * Read-only evidence collection for historical transfers. Deliberately has NO
 * state-writing interface: a 404 or a stale snapshot cannot change the ledger.
 * No cron/route registration; no upload, sharing, or notification capability.
 */
export interface StaleTransferRow {
  id: string
  project_id: string | null
  state: string
  frameio_file_id: string | null
  dropbox_rev: string | null
  created_at: string
  retired_at: string | null
  frameio_upload_enabled: boolean
}
export interface ProviderState {
  exists: boolean
  transcodeComplete: boolean
  hasShare: boolean
  sizeMatches: boolean | null
  identityMatches: boolean
  /** Not-found is not deletion proof; retained for the operator evidence report. */
  httpStatus?: number
}
export interface StaleDecision {
  id: string
  outcome: 'verified_ready_candidate' | 'leave_unresolved'
  reason: string
}
export function decideStaleOutcome(row: StaleTransferRow, provider: ProviderState | null): StaleDecision {
  if (provider?.exists && provider.identityMatches && provider.transcodeComplete &&
      provider.hasShare && provider.sizeMatches === true) {
    return { id: row.id, outcome: 'verified_ready_candidate', reason: 'Exact identity and media size verified; operator review required; no ledger write' }
  }
  return { id: row.id, outcome: 'leave_unresolved', reason: 'Missing, unverified, incomplete, inaccessible, or contradictory provider evidence; no ledger write' }
}
export function isSkippable(row: StaleTransferRow): { skip: boolean; reason?: string } {
  if (row.retired_at) return { skip: true, reason: 'retired' }
  if (!row.frameio_upload_enabled) return { skip: true, reason: 'project uploads disabled' }
  if (row.state !== 'processing') return { skip: true, reason: 'not processing' }
  return { skip: false }
}
export interface ReconcilerClient {
  loadStaleProcessing(olderThanHours: number): Promise<StaleTransferRow[]>
}
export interface ReconcileOptions {
  olderThanHours?: number
  dryRun?: boolean
  verifyProvider: (row: StaleTransferRow) => Promise<ProviderState | null>
  env?: Record<string, string | undefined>
}
export async function reconcileStaleTransfers(client: ReconcilerClient, opts: ReconcileOptions) {
  // Fail closed even if someone tries to enable a previously drafted write mode.
  if (opts.dryRun === false) throw new Error('Historical reconciliation is read-only')
  const enabled = (opts.env ?? process.env).STALE_TRANSFER_RECONCILER_ENABLED === 'true'
  const result = { enabled, dryRun: true, scanned: 0, skipped: [] as Array<{id: string; reason: string}>, decisions: [] as StaleDecision[], applied: 0 }
  if (!enabled) return result
  const hours = opts.olderThanHours ?? 48
  if (!Number.isFinite(hours) || hours < 24) throw new Error('Minimum historical window is 24 hours')
  const rows = await client.loadStaleProcessing(hours)
  result.scanned = rows.length
  for (const row of rows) {
    const skip = isSkippable(row)
    if (skip.skip) { result.skipped.push({id: row.id, reason: skip.reason!}); continue }
    const provider = await opts.verifyProvider(row).catch(() => null)
    result.decisions.push(decideStaleOutcome(row, provider))
  }
  return result
}
