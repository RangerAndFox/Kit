/**
 * Creation-request orchestration: idempotent project creation keyed by the Slack
 * view.id, plus authorization for the duplicate/replace/cancel actions.
 *
 * Extracted from the Bolt handler so the guarantees are unit-tested through the
 * REAL functions with injected fakes, not only live staging.
 */

// ─── Enabled-path routing state machine ──────────────────────────────────────
// Deterministic mapping from the current durable state to the action the Bolt
// modal-submit handler must take. Same-request ownership is checked BEFORE the
// project-number duplicate guard, so a crashed request's own project resumes
// instead of prompting the producer to duplicate/replace it.

export interface RouteInput {
  /** project_creation_requests.status for this view.id. */
  status: string
  /**
   * A project already created by THIS request — resolved by the caller from
   * either project_creation_requests.project_id OR projects.creation_request_id.
   * Null when this request has not yet produced a project.
   */
  linkedProjectId: string | null
  /** True while this request's lease is held and unexpired (a worker is active). */
  leaseActive: boolean
  /**
   * An existing non-archived project with the same project number that belongs
   * to a DIFFERENT request (a genuine clash). Null when none, or when the only
   * same-number project is this request's own (that is linkedProjectId).
   */
  unrelatedExisting: { id: string; name: string } | null
}

export type RouteAction =
  | { action: 'already_completed' }
  | { action: 'awaiting_decision' }
  | { action: 'in_flight' }
  | { action: 'resume'; projectId: string }
  | { action: 'duplicate_prompt'; existing: { id: string; name: string } }
  | { action: 'provision' }

/**
 * Route a new-project modal submission for the ENABLED path.
 *
 *   completed                         → already_completed (never provisions again)
 *   awaiting_decision                 → awaiting_decision (leave the open prompt)
 *   linked project + active lease     → in_flight (a worker is finishing it)
 *   linked project + no active lease  → resume (crash recovery, no new insert)
 *   no linked project + active lease  → in_flight (claimed, mid-insert)
 *   unrelated same-number project     → duplicate_prompt (genuine clash only)
 *   otherwise                         → provision
 *
 * `pending`, `error` and `provisioning` crash states therefore converge to
 * resume/provision without asking the user to duplicate their own project.
 */
export function routeCreationRequest(input: RouteInput): RouteAction {
  if (input.status === 'completed') return { action: 'already_completed' }
  if (input.status === 'awaiting_decision') return { action: 'awaiting_decision' }
  if (input.linkedProjectId) {
    return input.leaseActive
      ? { action: 'in_flight' }
      : { action: 'resume', projectId: input.linkedProjectId }
  }
  if (input.leaseActive) return { action: 'in_flight' }
  if (input.unrelatedExisting) return { action: 'duplicate_prompt', existing: input.unrelatedExisting }
  return { action: 'provision' }
}

export type ResolutionAction = 'duplicate' | 'replace' | 'cancel'

export interface RequestLike {
  workspace_id: string | null
  requested_by_slack_user_id: string | null
  status: string
}

export interface AuthContext {
  actingUserId: string
  workspaceId: string
  action: ResolutionAction
}

export type AuthDecision =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'wrong_workspace' | 'not_authorized' | 'invalid_state' }

/**
 * Authorize a duplicate-resolution action. Never relies on request-id secrecy
 * or button visibility:
 *   - the request must belong to the acting workspace;
 *   - the acting user must be the original requester (default authorization);
 *   - the request must be in a state that permits the transition.
 */
export function authorizeResolution(req: RequestLike | null, ctx: AuthContext): AuthDecision {
  if (!req) return { ok: false, reason: 'not_found' }
  if (!req.workspace_id || req.workspace_id !== ctx.workspaceId) return { ok: false, reason: 'wrong_workspace' }
  if (!req.requested_by_slack_user_id || req.requested_by_slack_user_id !== ctx.actingUserId) {
    return { ok: false, reason: 'not_authorized' }
  }
  if (req.status !== 'awaiting_decision') return { ok: false, reason: 'invalid_state' }
  return { ok: true }
}

// ─── Idempotent project creation ─────────────────────────────────────────────

export interface CreationRequestRecord {
  status: string
  project_id: string | null
}

export interface RequestStorePort {
  getOrCreateCreationRequest(o: {
    requestKey: string
    workspaceId: string | null
    requestedBy: string | null
    submission: Record<string, unknown>
  }): Promise<{ row: CreationRequestRecord; created: boolean }>
  loadCreationRequest(requestKey: string): Promise<CreationRequestRecord | null>
  updateCreationRequest(requestKey: string, patch: Record<string, unknown>): Promise<void>
  claimCreationRequest(requestKey: string, holder: string): Promise<boolean>
}

export interface EnsureProjectDeps {
  store: RequestStorePort
  insertProject: () => Promise<{ id: string }>
  /**
   * Discover an already-created project by its durable request identity
   * (projects.creation_request_id). Covers the crash window between a successful
   * project insert and the ledger's project_id link write.
   */
  findProjectByRequestId: (requestKey: string) => Promise<{ id: string } | null>
  holder: string
  /**
   * Set by the Railway recovery sweep, which has ALREADY reclaimed this
   * request's lease before resuming it. When true the resume skips the
   * redelivery-guard claim (it would otherwise fail against the lease the sweep
   * already holds) and proceeds resume-safely. The fresh Slack path leaves this
   * false so a redelivered submission is still blocked.
   */
  preClaimed?: boolean
}

export type EnsureStatus = 'created' | 'resumed' | 'already_completed' | 'in_flight'

export interface EnsureProjectResult {
  status: EnsureStatus
  projectId: string | null
}

export interface ResolveCreationDeps extends EnsureProjectDeps {
  /** When false, the durable creation-request workflow is bypassed entirely. */
  creationEnabled: boolean
}

/**
 * Entry point used by the provisioner. When creation is disabled it does NOT
 * touch any migration-056 store — it inserts the project directly, preserving
 * the pre-mission workflow (and not requiring the ledger tables to exist).
 */
export async function resolveCreationProject(
  deps: ResolveCreationDeps,
  args: { requestKey: string; workspaceId: string | null; requestedBy: string | null; submission: Record<string, unknown> },
): Promise<EnsureProjectResult> {
  if (!deps.creationEnabled) {
    const project = await deps.insertProject()
    return { status: 'created', projectId: project.id }
  }
  return ensureProjectForRequest(deps, args)
}

/**
 * Disabled-path creation step. Preserves the exact pre-mission order: announce
 * "Provisioning…" FIRST, then insert the project. Touches NO migration-056
 * store (the ledger is never consulted when creation is disabled).
 */
export async function runDisabledCreation(ports: {
  announce: () => Promise<void>
  insertProject: () => Promise<{ id: string }>
}): Promise<{ id: string }> {
  await ports.announce()
  return ports.insertProject()
}

/**
 * Ensure exactly one project exists for this request.
 *
 *   - a redelivered submission for a completed request → 'already_completed'
 *     (no new project);
 *   - a request whose lease is actively held → 'in_flight' (no double-run);
 *   - a request with an existing project_id (crash-after-insert) → 'resumed';
 *   - a project already inserted under this request identity but never linked
 *     (crash between insert and ledger update) → 'resumed' (no second insert);
 *   - otherwise inserts once → 'created'.
 *
 * An intentional duplicate is a different requestKey → its own request → insert.
 */
export async function ensureProjectForRequest(
  deps: EnsureProjectDeps,
  args: { requestKey: string; workspaceId: string | null; requestedBy: string | null; submission: Record<string, unknown> },
): Promise<EnsureProjectResult> {
  const { row } = await deps.store.getOrCreateCreationRequest({
    requestKey: args.requestKey,
    workspaceId: args.workspaceId,
    requestedBy: args.requestedBy,
    submission: args.submission,
  })
  if (row.status === 'completed') return { status: 'already_completed', projectId: row.project_id }

  // Exclusive claim: succeeds only if no live lease. An expired lease (crash) is
  // reclaimable, so a restart resumes; an actively-held lease blocks a re-run.
  // The recovery sweep already holds the lease (preClaimed), so it skips this
  // guard rather than fail against its own reclaim.
  if (!deps.preClaimed) {
    const claimed = await deps.store.claimCreationRequest(args.requestKey, deps.holder)
    if (!claimed) return { status: 'in_flight', projectId: row.project_id }
  }

  const latest = await deps.store.loadCreationRequest(args.requestKey)
  if (latest?.project_id) return { status: 'resumed', projectId: latest.project_id }

  // Crash-window guard: the projects row may already exist from a prior attempt
  // whose ledger link write never landed. Discover it by the durable identity
  // (projects.creation_request_id) BEFORE inserting, so a retry can never create
  // a second project.
  const found = await deps.findProjectByRequestId(args.requestKey)
  if (found) {
    await deps.store
      .updateCreationRequest(args.requestKey, { project_id: found.id, status: 'provisioning' })
      .catch(() => {}) // link is best-effort; the durable identity is authoritative
    return { status: 'resumed', projectId: found.id }
  }

  const project = await deps.insertProject()
  await deps.store.updateCreationRequest(args.requestKey, { project_id: project.id, status: 'provisioning' })
  return { status: 'created', projectId: project.id }
}
