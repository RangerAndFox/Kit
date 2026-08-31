/**
 * Supabase-owned durable state for the "update project" ripple: the update
 * request ledger (idempotency + apply/cancel decision + per-request lease) and
 * the per-(update_request, service) step ledger.
 *
 * Mirrors src/lib/project-control/store.ts exactly — same narrow typed facade
 * (`SupabaseLike`), same compare-and-set lease + monotonic fence, same
 * "getSteps THROWS on a store error" contract — but keyed by the update request
 * (migration 063) instead of the project, so an update ripple has its own fresh
 * step ledger and never collides with the create-side project_provisioning_steps.
 *
 * The step functions here satisfy the `StepLedger` interface consumed by
 * `runDurableProvisioning` (project-control/provisioning-steps.ts): the executor
 * passes the update-request id as the opaque ledger key.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { UpdateForm, UpdatePlan } from './update-diff'
import type { UpdateCurrentIds } from './update'

const nowIso = () => new Date().toISOString()
const UPDATE_LEASE_MS = 5 * 60 * 1000
const STEP_LEASE_MS = 5 * 60 * 1000 // > any bounded single provider call

// ─── Narrow Supabase facade (tables not yet in generated types) ──────────────

interface QueryResult { data: unknown; error: { message: string } | null }
interface FilterBuilder extends PromiseLike<QueryResult> {
  select(cols?: string): FilterBuilder
  eq(col: string, val: unknown): FilterBuilder
  neq(col: string, val: unknown): FilterBuilder
  in(col: string, vals: unknown[]): FilterBuilder
  or(filter: string): FilterBuilder
  maybeSingle(): Promise<QueryResult>
  single(): Promise<QueryResult>
}
interface TableBuilder {
  select(cols?: string): FilterBuilder
  insert(values: Record<string, unknown>): FilterBuilder
  update(values: Record<string, unknown>): FilterBuilder
  upsert(values: Record<string, unknown>, opts?: Record<string, unknown>): FilterBuilder
}
interface SupabaseLike {
  from(table: string): TableBuilder
}

let clientFactory: () => unknown = createAdminClient

/** Test seam: swap the Supabase client factory for a fake. Pass null to restore. */
export function __setUpdateStoreClientForTests(f: (() => unknown) | null): void {
  clientFactory = f || createAdminClient
}

function db(): SupabaseLike {
  return clientFactory() as unknown as SupabaseLike
}

// ─── Update request ledger ───────────────────────────────────────────────────

export interface UpdateRequestRow {
  id: string
  request_key: string
  workspace_id: string | null
  project_id: string
  requested_by_slack_user_id: string | null
  submission: UpdateRequestSubmission
  plan: UpdatePlan
  decision: string | null
  status: string
  attempts: number
  claimed_by: string | null
  claimed_at: string | null
  lease_expires_at: string | null
  fence: number
  error: string | null
  created_at: string
  updated_at: string
}

export interface UpdateRequestSubmission {
  form: UpdateForm
  userId: string
  statusChannel: string
  threadTs?: string
  workspaceId: string
  current: UpdateCurrentIds
}

/**
 * Idempotently get-or-create the request keyed by the update modal's view.id. A
 * redelivered submission returns the SAME row (its ripple is resumed, not
 * restarted). A fresh edit is a new view.id → a new row.
 */
export async function getOrCreateUpdateRequest(opts: {
  requestKey: string
  workspaceId: string | null
  projectId: string
  requestedBy: string | null
  submission: UpdateRequestSubmission
  plan: UpdatePlan
}): Promise<{ row: UpdateRequestRow; created: boolean }> {
  const existing = await loadUpdateRequest(opts.requestKey)
  if (existing) return { row: existing, created: false }
  const { data, error } = await db()
    .from('project_update_requests')
    .insert({
      request_key: opts.requestKey,
      workspace_id: opts.workspaceId,
      project_id: opts.projectId,
      requested_by_slack_user_id: opts.requestedBy,
      submission: opts.submission as unknown as Record<string, unknown>,
      plan: opts.plan as unknown as Record<string, unknown>,
      status: 'pending',
    })
    .select()
    .single()
  if (error) {
    // Unique-violation race: another worker inserted first — reload and reuse.
    const reloaded = await loadUpdateRequest(opts.requestKey)
    if (reloaded) return { row: reloaded, created: false }
    throw new Error(`getOrCreateUpdateRequest: ${error.message}`)
  }
  return { row: data as UpdateRequestRow, created: true }
}

/**
 * ATOMIC one-winner transition `pending` → `awaiting_confirm`, returning true only
 * for the caller that actually made it. A check-then-act read of `status` is not
 * enough: Slack Socket Mode can redeliver the same view_submission (identical
 * view.id), and a second delivery that arrives while the row is still `pending`
 * would pass a read-guard and post a DUPLICATE preview. The CAS closes that window
 * (and also short-circuits a row that already advanced to a decided/terminal
 * status). Mirrors commitUpdateDecision's one-winner pattern.
 */
export async function claimUpdatePreview(requestKey: string): Promise<boolean> {
  const { data, error } = await db()
    .from('project_update_requests')
    .update({ status: 'awaiting_confirm', updated_at: nowIso() })
    .eq('request_key', requestKey)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`claimUpdatePreview: ${error.message}`)
  return !!data
}

export async function loadUpdateRequest(requestKey: string): Promise<UpdateRequestRow | null> {
  const { data } = await db()
    .from('project_update_requests')
    .select('*')
    .eq('request_key', requestKey)
    .maybeSingle()
  return (data as UpdateRequestRow) || null
}

/** Load a request by its ROW id (uuid) — used by step-based recovery, which
 *  discovers requests via project_update_steps.update_request_id (a uuid). */
export async function loadUpdateRequestById(id: string): Promise<UpdateRequestRow | null> {
  const { data } = await db()
    .from('project_update_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  return (data as UpdateRequestRow) || null
}

export async function updateUpdateRequest(
  requestKey: string,
  patch: Partial<UpdateRequestRow>,
): Promise<void> {
  const { error } = await db()
    .from('project_update_requests')
    .update({ ...patch, updated_at: nowIso() })
    .eq('request_key', requestKey)
  if (error) throw new Error(`updateUpdateRequest: ${error.message}`)
}

/**
 * Atomically commit the apply/cancel decision via a compare-and-set transition
 * OUT of 'awaiting_confirm' with a NULL decision, conditioned on the stored
 * requester + workspace. Only the FIRST competing button action wins; every
 * later/racing click finds the row already transitioned and loses (returns
 * false). This is the authoritative gate — button visibility is never trusted.
 */
export async function commitUpdateDecision(opts: {
  requestKey: string
  actingUserId: string
  workspaceId: string
  decision: 'apply' | 'cancel'
}): Promise<boolean> {
  const nowStr = nowIso()
  const patch =
    opts.decision === 'cancel'
      ? { status: 'cancelled', decision: 'cancel', error: 'cancelled_by_user', updated_at: nowStr }
      : { decision: 'apply', status: 'applying', updated_at: nowStr }
  const { data, error } = await db()
    .from('project_update_requests')
    .update(patch)
    .eq('request_key', opts.requestKey)
    .eq('status', 'awaiting_confirm')
    .eq('requested_by_slack_user_id', opts.actingUserId)
    .eq('workspace_id', opts.workspaceId)
    .or('decision.is.null')
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`commitUpdateDecision: ${error.message}`)
  return !!data
}

/**
 * Fenced compare-and-set lease so only one worker drives a ripple at a time, and
 * returns the granted fence token. A reclaim (lease free/expired) bumps the fence
 * monotonically; the claimer keeps that fence for renewals and fenced writes so a
 * stale worker cannot clobber the new holder.
 */
export async function claimUpdateRequestFenced(
  requestKey: string,
  holder: string,
): Promise<{ ok: boolean; fence: number | null }> {
  const now = Date.now()
  const nowStr = new Date(now).toISOString()
  const current = await loadUpdateRequest(requestKey)
  const nextFence = Number(current?.fence ?? 0) + 1
  const { data } = await db()
    .from('project_update_requests')
    .update({
      claimed_by: holder,
      claimed_at: nowStr,
      lease_expires_at: new Date(now + UPDATE_LEASE_MS).toISOString(),
      fence: nextFence,
      updated_at: nowStr,
    })
    .eq('request_key', requestKey)
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowStr}`)
    .select('id')
    .maybeSingle()
  return { ok: !!data, fence: data ? nextFence : null }
}

/**
 * Renew (heartbeat) a held request lease: extend the expiry ONLY while this
 * holder still owns it. Returns false when the lease was lost (reclaimed by a
 * newer holder) — the caller must then stop writing. The fence is unchanged.
 */
export async function renewUpdateRequestLease(requestKey: string, holder: string): Promise<boolean> {
  const now = Date.now()
  const nowStr = new Date(now).toISOString()
  const { data } = await db()
    .from('project_update_requests')
    .update({ lease_expires_at: new Date(now + UPDATE_LEASE_MS).toISOString(), updated_at: nowStr })
    .eq('request_key', requestKey)
    .eq('claimed_by', holder)
    .select('id')
    .maybeSingle()
  return !!data
}

/**
 * Nonterminal update requests whose lease is free/expired — the Railway recovery
 * sweep's work list. A request stuck in 'applying'/'error' (or a decided
 * 'awaiting_confirm') is resumable after a crash. An actively-leased request is
 * skipped; 'completed'/'cancelled' are terminal. Throws on a DB error so a failed
 * read never masquerades as an empty work list.
 */
export async function listRecoverableUpdateRequests(): Promise<UpdateRequestRow[]> {
  const nowStr = new Date().toISOString()
  const { data, error } = await db()
    .from('project_update_requests')
    .select('*')
    .in('status', ['applying', 'error'])
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowStr}`)
  if (error) throw new Error(`listRecoverableUpdateRequests: ${error.message}`)
  return (data as UpdateRequestRow[]) || []
}

// ─── Per-service durable update steps (deterministic ownership) ───────────────

export type UpdateStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'terminal'

export interface UpdateStepRow {
  id: string
  update_request_id: string
  project_id: string
  service: string
  status: UpdateStepStatus
  result: Record<string, unknown> | null
  error: string | null
  claim_holder: string | null
  claimed_at: string | null
  lease_expires_at: string | null
  fence: number
  attempts: number
  input_hash: string | null
  external_id: string | null
  external_url: string | null
  created_at: string
  updated_at: string
}

/**
 * All persisted step rows for an update request. THROWS on a DB error — it must
 * never convert a Supabase failure into an empty ledger, which would make a
 * resume treat every service as un-run and replay them all.
 */
export async function getUpdateSteps(updateRequestId: string): Promise<UpdateStepRow[]> {
  const { data, error } = await db()
    .from('project_update_steps')
    .select('*')
    .eq('update_request_id', updateRequestId)
  if (error) throw new Error(`getUpdateSteps: ${error.message}`)
  return (data as UpdateStepRow[]) || []
}

export async function getUpdateStep(
  updateRequestId: string,
  service: string,
): Promise<UpdateStepRow | null> {
  const { data, error } = await db()
    .from('project_update_steps')
    .select('*')
    .eq('update_request_id', updateRequestId)
    .eq('service', service)
    .maybeSingle()
  if (error) throw new Error(`getUpdateStep: ${error.message}`)
  return (data as UpdateStepRow) || null
}

async function ensureUpdateStepRow(
  updateRequestId: string,
  projectId: string,
  service: string,
): Promise<void> {
  await db()
    .from('project_update_steps')
    .upsert(
      { update_request_id: updateRequestId, project_id: projectId, service },
      { onConflict: 'update_request_id,service', ignoreDuplicates: true },
    )
}

export interface UpdateStepClaim {
  ok: boolean
  fence: number | null
  status: UpdateStepStatus | 'missing'
  row: UpdateStepRow | null
}

/**
 * Atomically claim a step for execution. Bumps the fence (monotonic ownership
 * epoch) and increments attempts. Returns ok=false when the step is already
 * done/terminal (caller reuses/skips) or actively leased by another worker
 * (caller skips). Only a claim with ok=true may execute + commit.
 */
export async function claimUpdateStep(
  updateRequestId: string,
  projectId: string,
  service: string,
  holder: string,
  opts: { inputHash?: string } = {},
): Promise<UpdateStepClaim> {
  await ensureUpdateStepRow(updateRequestId, projectId, service)
  const cur = await getUpdateStep(updateRequestId, service)
  if (!cur) return { ok: false, fence: null, status: 'missing', row: null }
  if (cur.status === 'done' || cur.status === 'terminal') {
    return { ok: false, fence: cur.fence, status: cur.status, row: cur }
  }
  const now = Date.now()
  const nowStr = new Date(now).toISOString()
  const nextFence = Number(cur.fence ?? 0) + 1
  const { data, error } = await db()
    .from('project_update_steps')
    .update({
      claim_holder: holder,
      claimed_at: nowStr,
      lease_expires_at: new Date(now + STEP_LEASE_MS).toISOString(),
      status: 'running',
      fence: nextFence,
      attempts: Number(cur.attempts ?? 0) + 1,
      ...(opts.inputHash !== undefined ? { input_hash: opts.inputHash } : {}),
      updated_at: nowStr,
    })
    .eq('update_request_id', updateRequestId)
    .eq('service', service)
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowStr}`)
    .select('*')
    .maybeSingle()
  if (error) throw new Error(`claimUpdateStep: ${error.message}`)
  return {
    ok: !!data,
    fence: data ? nextFence : null,
    status: data ? 'running' : cur.status,
    row: (data as UpdateStepRow) ?? cur,
  }
}

/**
 * Persist the external identity the INSTANT it is known — holder/fence-conditional
 * so a stale worker can't write it. Returns whether the write committed.
 */
export async function recordUpdateStepExternalId(
  updateRequestId: string,
  service: string,
  holder: string,
  fence: number,
  o: { externalId?: string | null; externalUrl?: string | null },
): Promise<boolean> {
  const { data, error } = await db()
    .from('project_update_steps')
    .update({
      ...(o.externalId !== undefined ? { external_id: o.externalId } : {}),
      ...(o.externalUrl !== undefined ? { external_url: o.externalUrl } : {}),
      updated_at: nowIso(),
    })
    .eq('update_request_id', updateRequestId)
    .eq('service', service)
    .eq('claim_holder', holder)
    .eq('fence', fence)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`recordUpdateStepExternalId: ${error.message}`)
  return !!data
}


/**
 * Final result write — CONDITIONAL on the exact holder + fence. Returns whether
 * it committed; false means a newer holder reclaimed the step and this stale
 * worker's result was rejected.
 */
export async function completeUpdateStep(
  updateRequestId: string,
  service: string,
  holder: string,
  fence: number,
  patch: {
    status: 'done' | 'failed' | 'terminal'
    result?: Record<string, unknown> | null
    error?: string | null
    externalId?: string | null
    externalUrl?: string | null
  },
): Promise<boolean> {
  const { data, error } = await db()
    .from('project_update_steps')
    .update({
      status: patch.status,
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      error: patch.error ?? null,
      ...(patch.externalId !== undefined ? { external_id: patch.externalId } : {}),
      ...(patch.externalUrl !== undefined ? { external_url: patch.externalUrl } : {}),
      // Release the lease on a terminal-success/failure so recovery can reclaim a
      // 'failed' (retryable) step; 'done'/'terminal' are skipped by claim.
      claim_holder: null,
      lease_expires_at: null,
      updated_at: nowIso(),
    })
    .eq('update_request_id', updateRequestId)
    .eq('service', service)
    .eq('claim_holder', holder)
    .eq('fence', fence)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`completeUpdateStep: ${error.message}`)
  return !!data
}

/**
 * Update-request ids that have at least one RETRYABLE step (pending/running/
 * failed) whose lease is free/expired — the step-based recovery work list.
 * Throws on error so a failed read never masquerades as an empty list.
 */
export async function listUpdateRequestsWithIncompleteSteps(): Promise<string[]> {
  const nowStr = new Date().toISOString()
  const { data, error } = await db()
    .from('project_update_steps')
    .select('update_request_id')
    .in('status', ['pending', 'running', 'failed'])
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowStr}`)
  if (error) throw new Error(`listUpdateRequestsWithIncompleteSteps: ${error.message}`)
  const ids = new Set<string>()
  for (const r of (data as Array<{ update_request_id: string }>) || []) ids.add(r.update_request_id)
  return [...ids]
}
