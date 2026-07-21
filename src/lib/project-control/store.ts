/**
 * Supabase-owned durable state for Project Control: the creation-request ledger,
 * the project<->Sheet<->Canvas bindings, workbook leases, the Drive-version
 * cursor, and error-notification dedupe.
 *
 * All idempotency/exclusivity lives here (invariant 9/10): the in-memory
 * pending-provision Map is no longer the source of truth for creation.
 *
 * The generated `Database` type predates migration 056's tables, so DB access
 * goes through a narrow typed facade (`SupabaseLike`) until types are
 * regenerated post-migration. Every public function is fully typed.
 */

import { createAdminClient } from '@/lib/supabase/admin'

const nowIso = () => new Date().toISOString()
const CREATION_LEASE_MS = 5 * 60 * 1000
const SYNC_LEASE_MS = 10 * 60 * 1000

// ─── Narrow Supabase facade (tables not yet in generated types) ──────────────

interface QueryResult { data: unknown; error: { message: string } | null }
interface QueryBuilder extends PromiseLike<QueryResult> {
  select(cols?: string): QueryBuilder
  insert(values: Record<string, unknown>): QueryBuilder
  update(values: Record<string, unknown>): QueryBuilder
  upsert(values: Record<string, unknown>, opts?: Record<string, unknown>): QueryBuilder
  eq(col: string, val: unknown): QueryBuilder
  neq(col: string, val: unknown): QueryBuilder
  in(col: string, vals: unknown[]): QueryBuilder
  or(filter: string): QueryBuilder
  maybeSingle(): Promise<QueryResult>
  single(): Promise<QueryResult>
}
interface SupabaseLike {
  from(table: string): QueryBuilder
}

let clientFactory: () => unknown = createAdminClient

/** Test seam: swap the Supabase client factory for a fake. Pass null to restore. */
export function __setStoreClientForTests(f: (() => unknown) | null): void {
  clientFactory = f || createAdminClient
}

function db(): SupabaseLike {
  return clientFactory() as unknown as SupabaseLike
}

// ─── Creation request ledger ─────────────────────────────────────────────────

export interface CreationRequestRow {
  id: string
  request_key: string
  workspace_id: string | null
  requested_by_slack_user_id: string | null
  submission: Record<string, unknown>
  decision: string | null
  /** The project a 'replace' decision must archive (persisted before archive). */
  replace_target_project_id: string | null
  project_id: string | null
  status: string
  attempts: number
  claimed_by: string | null
  claimed_at: string | null
  lease_expires_at: string | null
  // Monotonic fence: bumped on each reclaim, unchanged by a renewal. A worker
  // keeps the fence it was granted and refuses to write once a newer one exists.
  fence: number
  error: string | null
  created_at: string
  updated_at: string
}

/**
 * Idempotently get-or-create the request keyed by Slack view.id. A redelivered
 * submission returns the SAME row (its project is resumed, not re-created). An
 * intentional duplicate is a new view.id → a new row.
 */
export async function getOrCreateCreationRequest(opts: {
  requestKey: string
  workspaceId: string | null
  requestedBy: string | null
  submission: Record<string, unknown>
}): Promise<{ row: CreationRequestRow; created: boolean }> {
  const existing = await loadCreationRequest(opts.requestKey)
  if (existing) return { row: existing, created: false }
  const { data, error } = await db()
    .from('project_creation_requests')
    .insert({
      request_key: opts.requestKey,
      workspace_id: opts.workspaceId,
      requested_by_slack_user_id: opts.requestedBy,
      submission: opts.submission,
      status: 'pending',
    })
    .select()
    .single()
  if (error) {
    // Unique-violation race: another worker inserted first — reload and reuse.
    const reloaded = await loadCreationRequest(opts.requestKey)
    if (reloaded) return { row: reloaded, created: false }
    throw new Error(`getOrCreateCreationRequest: ${error.message}`)
  }
  return { row: data as CreationRequestRow, created: true }
}

export async function loadCreationRequest(requestKey: string): Promise<CreationRequestRow | null> {
  const { data } = await db()
    .from('project_creation_requests')
    .select('*')
    .eq('request_key', requestKey)
    .maybeSingle()
  return (data as CreationRequestRow) || null
}

/** Find the request that produced a given project (for step-based recovery). */
export async function loadCreationRequestByProjectId(
  projectId: string,
): Promise<CreationRequestRow | null> {
  const { data } = await db()
    .from('project_creation_requests')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle()
  return (data as CreationRequestRow) || null
}

export async function updateCreationRequest(
  requestKey: string,
  patch: Partial<CreationRequestRow>,
): Promise<void> {
  const { error } = await db()
    .from('project_creation_requests')
    .update({ ...patch, updated_at: nowIso() })
    .eq('request_key', requestKey)
  if (error) throw new Error(`updateCreationRequest: ${error.message}`)
}

/**
 * Atomically commit a duplicate/replace/cancel decision via a compare-and-set
 * transition OUT of 'awaiting_decision' with a NULL decision, conditioned on the
 * stored requester + workspace. Only the FIRST competing button action wins;
 * every later/racing click finds the row already transitioned and loses (returns
 * false). This is the authoritative gate — button visibility is never trusted.
 */
export async function commitCreationDecision(opts: {
  requestKey: string
  actingUserId: string
  workspaceId: string
  decision: 'duplicate' | 'replace' | 'cancel'
}): Promise<boolean> {
  const nowStr = nowIso()
  // cancel is terminal with no decision recorded; duplicate/replace move to
  // provisioning and record the decision.
  const patch =
    opts.decision === 'cancel'
      ? { status: 'cancelled', error: 'cancelled_by_user', updated_at: nowStr }
      : { decision: opts.decision, status: 'provisioning', updated_at: nowStr }
  const { data, error } = await db()
    .from('project_creation_requests')
    .update(patch)
    .eq('request_key', opts.requestKey)
    .eq('status', 'awaiting_decision')
    .eq('requested_by_slack_user_id', opts.actingUserId)
    .eq('workspace_id', opts.workspaceId)
    .or('decision.is.null')
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`commitCreationDecision: ${error.message}`)
  return !!data
}

/** Compare-and-set lease so only one worker drives a request at a time. */
export async function claimCreationRequest(requestKey: string, holder: string): Promise<boolean> {
  return (await claimCreationRequestFenced(requestKey, holder)).ok
}

/**
 * Fenced claim: like `claimCreationRequest` but returns the granted fence token.
 * A reclaim (the lease was free/expired) bumps the fence monotonically; the
 * claimer keeps that fence and passes it to `renewCreationRequestLease` and to
 * fenced writes so a stale worker whose lease was reclaimed cannot clobber the
 * new holder. Only one concurrent claimant's CAS update matches the expired
 * filter, so the written fence stays monotonic.
 */
export async function claimCreationRequestFenced(
  requestKey: string,
  holder: string,
): Promise<{ ok: boolean; fence: number | null }> {
  const now = Date.now()
  const nowStr = new Date(now).toISOString()
  const current = await loadCreationRequest(requestKey)
  const nextFence = Number(current?.fence ?? 0) + 1
  const { data } = await db()
    .from('project_creation_requests')
    .update({
      claimed_by: holder,
      claimed_at: nowStr,
      lease_expires_at: new Date(now + CREATION_LEASE_MS).toISOString(),
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
 * newer holder) — the caller must then stop writing. The fence is unchanged by
 * a renewal, so a heartbeat never disturbs fencing.
 */
export async function renewCreationRequestLease(requestKey: string, holder: string): Promise<boolean> {
  const now = Date.now()
  const nowStr = new Date(now).toISOString()
  const { data } = await db()
    .from('project_creation_requests')
    .update({ lease_expires_at: new Date(now + CREATION_LEASE_MS).toISOString(), updated_at: nowStr })
    .eq('request_key', requestKey)
    .eq('claimed_by', holder)
    .select('id')
    .maybeSingle()
  return !!data
}

/**
 * Nonterminal creation requests whose lease is free/expired — the Railway
 * recovery sweep's work list. A request stuck in 'pending'/'provisioning'/
 * 'error', or an 'awaiting_decision' that already carries a decision, is
 * resumable after a crash. An actively-leased request is skipped (a live worker
 * owns it); a 'completed' request is terminal.
 */
export async function listRecoverableRequests(): Promise<CreationRequestRow[]> {
  const nowStr = new Date().toISOString()
  const { data } = await db()
    .from('project_creation_requests')
    .in('status', ['pending', 'awaiting_decision', 'provisioning', 'error'])
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowStr}`)
    .select('*')
  return (data as CreationRequestRow[]) || []
}

// ─── Bindings ────────────────────────────────────────────────────────────────

export interface BindingRow {
  id: string
  project_id: string
  spreadsheet_id: string
  sheet_id: number
  row_metadata_id: number | null
  source_template_file_id: string | null
  source_template_hash: string | null
  template_markdown: string | null
  canvas_id: string | null
  canvas_url: string | null
  creation_state: string
  sync_status: string
  last_row_hash: string | null
  last_synced_at: string | null
  error: string | null
  error_notified_key: string | null
  created_at: string
  updated_at: string
}

/** Create the binding row (creation_state='pending_sheet') if absent. */
export async function ensureBinding(opts: {
  projectId: string
  spreadsheetId: string
  sheetId: number
}): Promise<BindingRow> {
  const existing = await getBindingByProject(opts.projectId)
  if (existing) return existing
  const { data, error } = await db()
    .from('project_control_bindings')
    .insert({
      project_id: opts.projectId,
      spreadsheet_id: opts.spreadsheetId,
      sheet_id: opts.sheetId,
      creation_state: 'pending_sheet',
      sync_status: 'pending',
    })
    .select()
    .single()
  if (error) {
    const reloaded = await getBindingByProject(opts.projectId)
    if (reloaded) return reloaded
    throw new Error(`ensureBinding: ${error.message}`)
  }
  return data as BindingRow
}

export async function getBindingByProject(projectId: string): Promise<BindingRow | null> {
  const { data } = await db()
    .from('project_control_bindings')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle()
  return (data as BindingRow) || null
}

export async function updateBinding(projectId: string, patch: Partial<BindingRow>): Promise<void> {
  const { error } = await db()
    .from('project_control_bindings')
    .update({ ...patch, updated_at: nowIso() })
    .eq('project_id', projectId)
  if (error) throw new Error(`updateBinding: ${error.message}`)
}

/**
 * Bindings the sync should consider: the connected ones for this workbook. Sync
 * additionally re-processes any whose sync_status != 'synced' (recovery),
 * regardless of the Drive cursor.
 */
export async function listSyncableBindings(spreadsheetId: string): Promise<BindingRow[]> {
  const { data } = await db()
    .from('project_control_bindings')
    .select('*')
    .eq('spreadsheet_id', spreadsheetId)
    .eq('creation_state', 'connected')
  return (data as BindingRow[]) || []
}

/**
 * Bindings that never reached 'connected' (incomplete creation) — the Railway
 * recovery sweep re-drives these. The Vercel/Inngest sync deliberately ignores
 * them (it only re-renders already-connected bindings), so completing a stalled
 * creation binding is Railway-owned recovery, not sync's job.
 */
export async function listIncompleteBindings(spreadsheetId: string): Promise<BindingRow[]> {
  const { data } = await db()
    .from('project_control_bindings')
    .select('*')
    .eq('spreadsheet_id', spreadsheetId)
    .neq('creation_state', 'connected')
  return (data as BindingRow[]) || []
}

// ─── Workbook sync state: cursor + leases ────────────────────────────────────

export interface SyncStateRow {
  spreadsheet_id: string
  drive_version: string | null
  cursor_advanced_at: string | null
  creation_lease_holder: string | null
  creation_lease_expires_at: string | null
  creation_fence: number
  sync_lease_holder: string | null
  sync_lease_expires_at: string | null
  sync_fence: number
}

async function ensureSyncStateRow(spreadsheetId: string): Promise<void> {
  await db()
    .from('sheet_sync_state')
    .upsert({ spreadsheet_id: spreadsheetId }, { onConflict: 'spreadsheet_id', ignoreDuplicates: true })
}

export async function getSyncState(spreadsheetId: string): Promise<SyncStateRow | null> {
  const { data } = await db()
    .from('sheet_sync_state')
    .select('*')
    .eq('spreadsheet_id', spreadsheetId)
    .maybeSingle()
  return (data as SyncStateRow) || null
}

/** Exclusive workbook lease (kind = 'creation' | 'sync'), compare-and-set. */
export async function claimWorkbookLease(
  spreadsheetId: string,
  kind: 'creation' | 'sync',
  holder: string,
): Promise<boolean> {
  return (await claimWorkbookLeaseFenced(spreadsheetId, kind, holder)).ok
}

/**
 * Fenced workbook claim: compare-and-set on the expiry, returning the granted
 * fence token. Each reclaim bumps `${kind}_fence` monotonically; a renewal
 * leaves it. The holder passes the fence to fenced writes so a stale worker
 * (reclaimed after a pause) cannot clobber the new holder's canvas/binding work.
 */
export async function claimWorkbookLeaseFenced(
  spreadsheetId: string,
  kind: 'creation' | 'sync',
  holder: string,
): Promise<{ ok: boolean; fence: number | null }> {
  await ensureSyncStateRow(spreadsheetId)
  const now = Date.now()
  const nowStr = new Date(now).toISOString()
  const ms = kind === 'sync' ? SYNC_LEASE_MS : CREATION_LEASE_MS
  const holderCol = `${kind}_lease_holder`
  const expiresCol = `${kind}_lease_expires_at`
  const fenceCol = `${kind}_fence`
  const current = await getSyncState(spreadsheetId)
  const nextFence = Number((current as unknown as Record<string, unknown> | null)?.[fenceCol] ?? 0) + 1
  const { data } = await db()
    .from('sheet_sync_state')
    .update({
      [holderCol]: holder,
      [expiresCol]: new Date(now + ms).toISOString(),
      [fenceCol]: nextFence,
      updated_at: nowStr,
    })
    .eq('spreadsheet_id', spreadsheetId)
    .or(`${expiresCol}.is.null,${expiresCol}.lt.${nowStr}`)
    .select('spreadsheet_id')
    .maybeSingle()
  return { ok: !!data, fence: data ? nextFence : null }
}

/**
 * Renew (heartbeat) a held workbook lease: extend the expiry ONLY while this
 * holder still owns it. Returns false when the lease was lost — the caller must
 * then stop writing to the workbook/canvas. The fence is unchanged.
 */
export async function renewWorkbookLease(
  spreadsheetId: string,
  kind: 'creation' | 'sync',
  holder: string,
): Promise<boolean> {
  const now = Date.now()
  const nowStr = new Date(now).toISOString()
  const ms = kind === 'sync' ? SYNC_LEASE_MS : CREATION_LEASE_MS
  const { data } = await db()
    .from('sheet_sync_state')
    .update({ [`${kind}_lease_expires_at`]: new Date(now + ms).toISOString(), updated_at: nowStr })
    .eq('spreadsheet_id', spreadsheetId)
    .eq(`${kind}_lease_holder`, holder)
    .select('spreadsheet_id')
    .maybeSingle()
  return !!data
}

/**
 * Ownership-safe release: clears the lease ONLY when spreadsheet_id matches AND
 * the stored holder equals the caller's holder token. A worker whose lease has
 * already expired and been reclaimed by another holder cannot release it.
 */
export async function releaseWorkbookLease(
  spreadsheetId: string,
  kind: 'creation' | 'sync',
  holder: string,
): Promise<void> {
  await db()
    .from('sheet_sync_state')
    .update({ [`${kind}_lease_holder`]: null, [`${kind}_lease_expires_at`]: null, updated_at: nowIso() })
    .eq('spreadsheet_id', spreadsheetId)
    .eq(`${kind}_lease_holder`, holder)
}

export async function advanceCursor(spreadsheetId: string, driveVersion: string): Promise<void> {
  await db()
    .from('sheet_sync_state')
    .update({ drive_version: driveVersion, cursor_advanced_at: nowIso(), updated_at: nowIso() })
    .eq('spreadsheet_id', spreadsheetId)
}

// ─── Notification dedupe ─────────────────────────────────────────────────────

/**
 * Returns true (and records the key) only when this error/recovery signature
 * differs from the last one announced for this binding — so transitions are
 * announced once, not every tick.
 */
export async function claimNotification(projectId: string, key: string): Promise<boolean> {
  const binding = await getBindingByProject(projectId)
  if (!binding) return false
  if (binding.error_notified_key === key) return false
  await updateBinding(projectId, { error_notified_key: key })
  return true
}

// ─── Per-service durable provisioning steps (deterministic ownership) ─────────

const STEP_LEASE_MS = 5 * 60 * 1000 // > any bounded single provider call

export type ProvisioningStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'terminal'

export interface ProvisioningStepRow {
  id: string
  project_id: string
  service: string
  status: ProvisioningStepStatus
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
 * All persisted step rows for a project. THROWS on a DB error — it must never
 * convert a Supabase failure into an empty ledger, which would make a resume
 * treat every service as un-run and replay them all.
 */
export async function getProvisioningSteps(projectId: string): Promise<ProvisioningStepRow[]> {
  const { data, error } = await db()
    .from('project_provisioning_steps')
    .select('*')
    .eq('project_id', projectId)
  if (error) throw new Error(`getProvisioningSteps: ${error.message}`)
  return (data as ProvisioningStepRow[]) || []
}

export async function getProvisioningStep(
  projectId: string,
  service: string,
): Promise<ProvisioningStepRow | null> {
  const { data, error } = await db()
    .from('project_provisioning_steps')
    .select('*')
    .eq('project_id', projectId)
    .eq('service', service)
    .maybeSingle()
  if (error) throw new Error(`getProvisioningStep: ${error.message}`)
  return (data as ProvisioningStepRow) || null
}

async function ensureStepRow(projectId: string, service: string): Promise<void> {
  await db()
    .from('project_provisioning_steps')
    .upsert({ project_id: projectId, service }, { onConflict: 'project_id,service', ignoreDuplicates: true })
}

export interface StepClaim {
  ok: boolean
  /** The granted fence to pass to record/complete; null when not claimed. */
  fence: number | null
  /** Current status (for the caller to decide reuse vs skip when ok=false). */
  status: ProvisioningStepStatus | 'missing'
  row: ProvisioningStepRow | null
}

/**
 * Atomically claim a step for execution. Bumps the fence (monotonic ownership
 * epoch) and increments attempts. Returns ok=false when the step is already
 * done/terminal (caller reuses/records) or actively leased by another worker
 * (caller skips — in flight). Only a claim with ok=true may execute + commit.
 */
export async function claimProvisioningStep(
  projectId: string,
  service: string,
  holder: string,
  opts: { inputHash?: string } = {},
): Promise<StepClaim> {
  await ensureStepRow(projectId, service)
  const cur = await getProvisioningStep(projectId, service)
  if (!cur) return { ok: false, fence: null, status: 'missing', row: null }
  if (cur.status === 'done' || cur.status === 'terminal') {
    return { ok: false, fence: cur.fence, status: cur.status, row: cur }
  }
  const now = Date.now()
  const nowStr = new Date(now).toISOString()
  const nextFence = Number(cur.fence ?? 0) + 1
  const { data, error } = await db()
    .from('project_provisioning_steps')
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
    .eq('project_id', projectId)
    .eq('service', service)
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowStr}`)
    .select('*')
    .maybeSingle()
  if (error) throw new Error(`claimProvisioningStep: ${error.message}`)
  return {
    ok: !!data,
    fence: data ? nextFence : null,
    status: data ? 'running' : cur.status,
    row: (data as ProvisioningStepRow) ?? cur,
  }
}

/**
 * Persist the external identity the INSTANT it is known (before follow-up setup)
 * — holder/fence-conditional so a stale worker can't write it. Returns whether
 * the write committed (i.e. we still own the step).
 */
export async function recordStepExternalId(
  projectId: string,
  service: string,
  holder: string,
  fence: number,
  o: { externalId?: string | null; externalUrl?: string | null },
): Promise<boolean> {
  const { data, error } = await db()
    .from('project_provisioning_steps')
    .update({
      ...(o.externalId !== undefined ? { external_id: o.externalId } : {}),
      ...(o.externalUrl !== undefined ? { external_url: o.externalUrl } : {}),
      updated_at: nowIso(),
    })
    .eq('project_id', projectId)
    .eq('service', service)
    .eq('claim_holder', holder)
    .eq('fence', fence)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`recordStepExternalId: ${error.message}`)
  return !!data
}

/** Heartbeat a claimed step's lease (holder-conditional). */
export async function renewProvisioningStep(
  projectId: string,
  service: string,
  holder: string,
): Promise<boolean> {
  const now = Date.now()
  const nowStr = new Date(now).toISOString()
  const { data, error } = await db()
    .from('project_provisioning_steps')
    .update({ lease_expires_at: new Date(now + STEP_LEASE_MS).toISOString(), updated_at: nowStr })
    .eq('project_id', projectId)
    .eq('service', service)
    .eq('claim_holder', holder)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`renewProvisioningStep: ${error.message}`)
  return !!data
}

/**
 * Final result write — CONDITIONAL on the exact holder + fence. Returns whether
 * it committed; false means a newer holder reclaimed the step and this stale
 * worker's result was rejected.
 */
export async function completeProvisioningStep(
  projectId: string,
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
    .from('project_provisioning_steps')
    .update({
      status: patch.status,
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      error: patch.error ?? null,
      ...(patch.externalId !== undefined ? { external_id: patch.externalId } : {}),
      ...(patch.externalUrl !== undefined ? { external_url: patch.externalUrl } : {}),
      // Release the lease on a terminal-success/failure so recovery can reclaim
      // a 'failed' (retryable) step; 'done'/'terminal' are skipped by claim.
      claim_holder: null,
      lease_expires_at: null,
      updated_at: nowIso(),
    })
    .eq('project_id', projectId)
    .eq('service', service)
    .eq('claim_holder', holder)
    .eq('fence', fence)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`completeProvisioningStep: ${error.message}`)
  return !!data
}

/**
 * Distinct project ids that have at least one RETRYABLE step (pending/running/
 * failed) whose lease is free/expired — the step-based recovery work list. This
 * discovers stranded work even if the creation-request state became inconsistent
 * (e.g. wrongly marked completed while a step is still failed). Throws on error.
 */
export async function listProjectsWithIncompleteSteps(): Promise<string[]> {
  const nowStr = new Date().toISOString()
  const { data, error } = await db()
    .from('project_provisioning_steps')
    .in('status', ['pending', 'running', 'failed'])
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowStr}`)
    .select('project_id')
  if (error) throw new Error(`listProjectsWithIncompleteSteps: ${error.message}`)
  const ids = new Set<string>()
  for (const r of (data as Array<{ project_id: string }>) || []) ids.add(r.project_id)
  return [...ids]
}
