/**
 * Railway-owned Project Control recovery sweep.
 *
 * The Vercel/Inngest sync only re-renders bindings that already reached
 * 'connected'. Two failure classes are therefore Railway's to recover, because
 * Railway owns creation:
 *
 *   1. Nonterminal creation requests — a request stuck in 'pending',
 *      'provisioning', 'error', or an 'awaiting_decision' that already carries a
 *      user decision, whose lease has expired (the worker crashed). Recovery
 *      reclaims the lease and resumes the SAME request (idempotent: the ledger
 *      + projects.creation_request_id guarantee no second project).
 *
 *   2. Incomplete bindings — a binding that never reached 'connected' (the Sheet
 *      row or Canvas step failed at creation time). Recovery re-drives the bind,
 *      which is idempotent (metadata search before write; canvas reconcile).
 *
 * Restart-safe duplicate/replace (item 3): recovery NEVER decides for the user.
 * An 'awaiting_decision' request with NO decision is left alone (the prompt is
 * still open). One WITH a decision is resumed honoring that stored decision, so
 * a crash after the user clicked duplicate/replace still completes. A
 * 'cancelled' request is terminal and never listed.
 *
 * Pure + injected so the decision/skip/idempotency logic is unit-tested with
 * fakes; the Bolt wiring supplies real resume/rebind callbacks.
 */

export interface RecoverableRequest {
  request_key: string
  status: string
  decision: string | null
  project_id: string | null
  submission: Record<string, unknown>
  workspace_id: string | null
  requested_by_slack_user_id: string | null
}

export interface IncompleteBinding {
  project_id: string
  creation_state: string
}

export interface RecoveryDeps {
  listRecoverableRequests(): Promise<RecoverableRequest[]>
  /** Fenced compare-and-set claim; ok=false ⇒ a live worker owns it, skip. */
  claimRequest(requestKey: string, holder: string): Promise<{ ok: boolean; fence: number | null }>
  /**
   * Re-run the provisioning pipeline for this request (idempotent). Receives the
   * exact holder the sweep just claimed with, so the resume heartbeats the SAME
   * lease it reclaimed rather than racing itself.
   */
  resumeRequest(req: RecoverableRequest, holder: string): Promise<void>
  listIncompleteBindings(): Promise<IncompleteBinding[]>
  /** Re-drive bindProjectControl for this binding (idempotent). */
  rebind(binding: IncompleteBinding): Promise<void>
  /** Stable prefix; the sweep appends a per-acquisition unique suffix. */
  makeHolder: (requestKey: string) => string
}

export interface RecoverySummary {
  ran: boolean
  requestsConsidered: number
  requestsResumed: number
  requestsSkippedAwaitingUser: number
  requestsSkippedLeased: number
  requestsFailed: number
  bindingsConsidered: number
  bindingsRebound: number
  bindingsFailed: number
}

/**
 * True when a recoverable request is genuinely resumable. An 'awaiting_decision'
 * request is resumable ONLY once the user has chosen (decision set); until then
 * the prompt is still theirs to answer and recovery must not act.
 */
export function isResumable(req: { status: string; decision: string | null }): boolean {
  if (req.status === 'awaiting_decision') return !!req.decision
  return req.status === 'pending' || req.status === 'provisioning' || req.status === 'error'
}

export async function runProjectControlRecovery(deps: RecoveryDeps): Promise<RecoverySummary> {
  const summary: RecoverySummary = {
    ran: true,
    requestsConsidered: 0,
    requestsResumed: 0,
    requestsSkippedAwaitingUser: 0,
    requestsSkippedLeased: 0,
    requestsFailed: 0,
    bindingsConsidered: 0,
    bindingsRebound: 0,
    bindingsFailed: 0,
  }

  // ── 1. Resume nonterminal creation requests ──────────────────────────────
  const requests = await deps.listRecoverableRequests()
  summary.requestsConsidered = requests.length
  for (const req of requests) {
    if (!isResumable(req)) {
      summary.requestsSkippedAwaitingUser++
      continue
    }
    // Reclaim the lease so exactly one recoverer drives it; an active lease
    // (live worker or a peer recoverer) means skip. The same holder is passed to
    // the resume so its heartbeat renews the lease this sweep now owns.
    const holder = deps.makeHolder(req.request_key)
    const claim = await deps.claimRequest(req.request_key, holder)
    if (!claim.ok) {
      summary.requestsSkippedLeased++
      continue
    }
    try {
      await deps.resumeRequest(req, holder)
      summary.requestsResumed++
    } catch {
      summary.requestsFailed++
    }
  }

  // ── 2. Re-drive incomplete bindings ──────────────────────────────────────
  const bindings = await deps.listIncompleteBindings()
  summary.bindingsConsidered = bindings.length
  for (const b of bindings) {
    try {
      await deps.rebind(b)
      summary.bindingsRebound++
    } catch {
      summary.bindingsFailed++
    }
  }

  return summary
}
