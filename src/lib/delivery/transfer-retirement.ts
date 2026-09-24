/**
 * Audited retirement of historical Frame.io delivery-transfer rows.
 *
 * DRAFT / NOT WIRED. No cron, command, or route calls this; it exists so the
 * Fabric (2637) and similar historical queues can be retired *deliberately and
 * auditably* — never by a blind sweep. Guarantees:
 *   - Never marks a row `ready`/delivered (the migration CHECK also forbids it).
 *   - Refuses to retire an already-`ready` transfer (can't retire a delivery).
 *   - Idempotent: re-retiring an already-retired row is a no-op.
 *   - Preserves the row + writes an append-only audit record (who/why/evidence).
 *   - Also retires the transfer's durable inbox events so they can't be
 *     reclaimed (paired with the claim_dropbox_events `retired_at is null` guard).
 *   - `dryRun` defaults TRUE: callers must opt in to writes.
 *
 * The decision logic (`classifyForRetirement`) is pure and unit-tested; the IO
 * wrapper is a thin, reviewable layer over an injected client.
 */

export interface TransferRow {
  id: string
  project_id: string | null
  state: string // 'processing' | 'ready' | 'failed'
  dropbox_file_id: string | null
  dropbox_rev: string | null
  retired_at: string | null
}

export type RetirementDisposition = 'eligible' | 'already_retired' | 'refused_delivered'

export interface RetirementDecision {
  id: string
  disposition: RetirementDisposition
  reason: string
}

export interface RetirementPlan {
  eligible: RetirementDecision[]
  alreadyRetired: RetirementDecision[]
  refused: RetirementDecision[]
}

/**
 * PURE. Decide, per transfer, whether it may be retired. A `ready` (delivered)
 * transfer is refused; an already-retired one is a no-op; anything else is
 * eligible. Never returns an action that would mark a row delivered.
 */
export function classifyForRetirement(rows: TransferRow[]): RetirementPlan {
  const plan: RetirementPlan = { eligible: [], alreadyRetired: [], refused: [] }
  for (const row of rows) {
    if (row.retired_at) {
      plan.alreadyRetired.push({ id: row.id, disposition: 'already_retired', reason: 'already retired' })
    } else if (row.state === 'ready') {
      plan.refused.push({
        id: row.id, disposition: 'refused_delivered',
        reason: 'transfer is delivered (state=ready); a delivered transfer cannot be retired',
      })
    } else {
      plan.eligible.push({ id: row.id, disposition: 'eligible', reason: `retire from state=${row.state}` })
    }
  }
  return plan
}

// ── IO layer (injected client; default binds to the admin client at call time) ──

export interface RetirementClient {
  loadTransfers(ids: string[]): Promise<TransferRow[]>
  markTransferRetired(id: string, reason: string, by: string): Promise<void>
  insertAudit(entry: {
    transfer_id: string; project_id: string | null; dropbox_file_id: string | null;
    dropbox_rev: string | null; prior_state: string; reason: string; retired_by: string;
    evidence: Record<string, unknown> | null
  }): Promise<void>
  retireInboxEventsForFile(projectId: string | null, dropboxFileId: string | null, reason: string): Promise<number>
}

export interface RetireOptions {
  transferIds: string[]
  reason: string
  retiredBy: string
  evidence?: Record<string, unknown> | null
  /** Defaults TRUE — no writes unless explicitly disabled. */
  dryRun?: boolean
}

export interface RetireResult {
  dryRun: boolean
  plan: RetirementPlan
  retiredTransferIds: string[]
  retiredInboxEvents: number
}

/**
 * Retire the given transfers (dry-run by default). Loads current rows, classifies
 * them, and — only when `dryRun === false` — writes the audit record, sets
 * `retired_at`, and retires the matching inbox events. Refused (delivered) rows
 * are never touched. Idempotent.
 */
export async function retireTransfers(client: RetirementClient, opts: RetireOptions): Promise<RetireResult> {
  const dryRun = opts.dryRun !== false
  const rows = await client.loadTransfers(opts.transferIds)
  const plan = classifyForRetirement(rows)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const retiredTransferIds: string[] = []
  let retiredInboxEvents = 0

  if (!dryRun) {
    for (const decision of plan.eligible) {
      const row = byId.get(decision.id)!
      await client.insertAudit({
        transfer_id: row.id, project_id: row.project_id,
        dropbox_file_id: row.dropbox_file_id, dropbox_rev: row.dropbox_rev,
        prior_state: row.state, reason: opts.reason, retired_by: opts.retiredBy,
        evidence: opts.evidence ?? null,
      })
      await client.markTransferRetired(row.id, opts.reason, opts.retiredBy)
      retiredTransferIds.push(row.id)
      retiredInboxEvents += await client.retireInboxEventsForFile(row.project_id, row.dropbox_file_id, opts.reason)
    }
  }

  return { dryRun, plan, retiredTransferIds, retiredInboxEvents }
}
