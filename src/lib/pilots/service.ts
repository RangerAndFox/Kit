/**
 * Pilots — orchestration over injected ports.
 *
 * This is the state-transition owner and the single authorization boundary.
 * EVERY public operation takes an `ActorContext` and is authorized through one
 * shared path (`requirePilotAccess` / `requireProjectAccess`) before any read or
 * write: the authoritative workspace is derived from the existing project/pilot
 * RECORD, never trusted from caller input, and the acting user must be present.
 * Because these operations run under the Supabase service role (RLS does not
 * protect them), this layer — not RLS, not the handler — is where cross-workspace
 * access is rejected.
 *
 * Persistence is delegated to a PilotStorePort and Canvas I/O to a
 * PilotCanvasPort; both are injected so the guarantees are unit-tested with
 * in-memory fakes. `defaultPilotDeps()` (in ./defaults) wires the real store +
 * canvas for the Bolt handler, which stays thin.
 */

import { pilotCanvasTitle } from './canvas'
import { renderPilotCanvas } from './render'
import type { ProjectInfo } from './store'
import { authorizePilotAction, decideFinalize, type AuthDecision, type FinalizeDecision } from './transitions'
import type {
  EvidenceCategory,
  EvidenceRow,
  GenerationRow,
  MaterialMapRow,
  MaterialMapType,
  PilotRow,
  PilotSnapshot,
  ReferenceRow,
  ReferenceType,
  ValidationRow,
  ValidationTool,
} from './types'

// ─── Actor context ───────────────────────────────────────────────────────────

/** Authenticated caller. The service authorizes every operation against this. */
export interface ActorContext {
  actingUserId: string
  workspaceId: string
}

// ─── Ports ───────────────────────────────────────────────────────────────────

export interface PilotStorePort {
  /** Authoritative workspace of an existing project (for create authorization). */
  getProjectWorkspaceId(projectId: string): Promise<string | null>
  getPilotById(id: string): Promise<PilotRow | null>
  getActivePilot(projectId: string, pilotType: string): Promise<PilotRow | null>
  insertPilot(v: {
    project_id: string
    workspace_id: string | null
    pilot_type: string
    title: string | null
    created_by: string | null
  }): Promise<PilotRow>
  updatePilot(id: string, patch: Partial<PilotRow>): Promise<void>
  insertReference(v: Omit<ReferenceRow, 'id' | 'created_at'>): Promise<ReferenceRow>
  insertEvidence(v: Omit<EvidenceRow, 'id' | 'created_at'>): Promise<EvidenceRow>
  insertGeneration(
    v: Omit<GenerationRow, 'id' | 'created_at' | 'acceptance' | 'accepted_by' | 'accepted_at'>,
  ): Promise<GenerationRow>
  getGenerationById(id: string): Promise<GenerationRow | null>
  setGenerationAcceptance(
    id: string,
    patch: { acceptance: 'accepted' | 'rejected'; accepted_by: string | null; accepted_at: string | null },
  ): Promise<void>
  insertMaterialMap(v: Omit<MaterialMapRow, 'id' | 'created_at'>): Promise<MaterialMapRow>
  insertValidation(v: Omit<ValidationRow, 'id' | 'created_at'>): Promise<ValidationRow>
  loadSnapshot(pilotId: string): Promise<PilotSnapshot | null>
  // Read-only diagnostics support (Workstreams 1-3).
  getProjectInfo(projectId: string): Promise<ProjectInfo>
  pilotSchemaPresent(): Promise<boolean>
  countActivePilots(): Promise<number>
}

export interface PilotCanvasPort {
  createPilotCanvas(o: { channelId: string; title: string; markdown: string }): Promise<{ canvasId: string; canvasUrl: string | null }>
  editPilotCanvas(o: { canvasId: string; title: string; markdown: string }): Promise<void>
}

export interface PilotDeps {
  store: PilotStorePort
  canvas: PilotCanvasPort
  now: () => string
}

// `defaultPilotDeps()` (the real Supabase/Slack wiring) lives in ./defaults so
// this orchestration module stays free of I/O imports and is unit-testable
// without the Supabase client installed.

// ─── Results ─────────────────────────────────────────────────────────────────

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; detail?: unknown }

function ok<T>(value: T): ServiceResult<T> {
  return { ok: true, value }
}
function fail<T>(reason: string, detail?: unknown): ServiceResult<T> {
  return { ok: false, reason, detail }
}

// Type-guard narrowing (not boolean-discriminant narrowing) so these compile
// identically under the root's strict tsconfig AND the Bolt package's
// non-strict one, where `if (!x.ok)` does not narrow a boolean-tagged union.
export function isErr(r: ServiceResult<unknown>): r is { ok: false; reason: string; detail?: unknown } {
  return !r.ok
}
function isDenied(a: AuthDecision): a is Extract<AuthDecision, { ok: false }> {
  return !a.ok
}
function isBlocked(d: FinalizeDecision): d is Extract<FinalizeDecision, { ok: false }> {
  return !d.ok
}

// ─── Shared authorization path ───────────────────────────────────────────────

/**
 * Authorize an operation on an existing pilot. Loads the pilot and derives the
 * authoritative workspace FROM THE RECORD (never from caller input). Returns the
 * loaded pilot for reuse so callers don't re-fetch.
 */
async function requirePilotAccess(
  deps: PilotDeps,
  pilotId: string,
  actor: ActorContext,
): Promise<ServiceResult<PilotRow>> {
  const pilot = await deps.store.getPilotById(pilotId)
  const auth = authorizePilotAction(pilot, actor)
  if (isDenied(auth)) return fail(`unauthorized:${auth.reason}`)
  return ok(pilot as PilotRow)
}

/**
 * Authorize creating a pilot for an existing project: the project must exist and
 * its authoritative workspace (from the projects record) must match the actor's
 * workspace. Returns the project's workspace id so the new pilot is stamped with
 * the authoritative value, not caller input.
 */
async function requireProjectAccess(
  deps: PilotDeps,
  projectId: string,
  actor: ActorContext,
): Promise<ServiceResult<string>> {
  if (!actor.actingUserId) return fail('unauthorized:not_authorized')
  const projectWorkspaceId = await deps.store.getProjectWorkspaceId(projectId)
  if (!projectWorkspaceId) return fail('project_not_found')
  if (projectWorkspaceId !== actor.workspaceId) return fail('unauthorized:wrong_workspace')
  return ok(projectWorkspaceId)
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function createVisualDevPilot(
  deps: PilotDeps,
  args: { projectId: string; title: string | null; actor: ActorContext },
): Promise<ServiceResult<PilotRow>> {
  const access = await requireProjectAccess(deps, args.projectId, args.actor)
  if (isErr(access)) return access
  const projectWorkspaceId = access.value

  // Defensive pre-check mirroring the DB partial-unique index: at most one active
  // pilot of this type per project. The index is the authoritative guarantee.
  const existing = await deps.store.getActivePilot(args.projectId, 'visual_development')
  if (existing) return fail('active_pilot_exists', existing.id)

  const pilot = await deps.store.insertPilot({
    project_id: args.projectId,
    // Authoritative workspace derived from the project, never caller input.
    workspace_id: projectWorkspaceId,
    pilot_type: 'visual_development',
    title: args.title,
    created_by: args.actor.actingUserId,
  })
  return ok(pilot)
}

// ─── References ──────────────────────────────────────────────────────────────

export async function addReference(
  deps: PilotDeps,
  args: {
    pilotId: string
    refType: ReferenceType
    url?: string | null
    label?: string | null
    description?: string | null
    provenance?: Record<string, unknown> | null
    actor: ActorContext
  },
): Promise<ServiceResult<ReferenceRow>> {
  const access = await requirePilotAccess(deps, args.pilotId, args.actor)
  if (isErr(access)) return access
  // Pinterest / Figma references require a non-empty (trimmed) URL — matches the
  // DB constraint so a whitespace-only value is rejected here too.
  if ((args.refType === 'pinterest' || args.refType === 'figma_moodboard') && !nonEmpty(args.url)) {
    return fail('url_required')
  }
  const row = await deps.store.insertReference({
    pilot_id: args.pilotId,
    ref_type: args.refType,
    url: args.url ?? null,
    label: args.label ?? null,
    description: args.description ?? null,
    provenance: args.provenance ?? null,
    author: args.actor.actingUserId,
  })
  return ok(row)
}

// ─── Visual language ─────────────────────────────────────────────────────────

export async function setVisualLanguage(
  deps: PilotDeps,
  args: { pilotId: string; text: string; actor: ActorContext },
): Promise<ServiceResult<null>> {
  const access = await requirePilotAccess(deps, args.pilotId, args.actor)
  if (isErr(access)) return access
  if (!nonEmpty(args.text)) return fail('empty_visual_language')
  await deps.store.updatePilot(args.pilotId, { visual_language: args.text })
  return ok(null)
}

// ─── Evidence (append-only) ──────────────────────────────────────────────────

export async function recordEvidence(
  deps: PilotDeps,
  args: {
    pilotId: string
    category: EvidenceCategory
    metricKey?: string | null
    label?: string | null
    valueNumeric?: number | null
    valueText?: string | null
    unit?: string | null
    observedAt?: string | null
    provenance?: Record<string, unknown> | null
    actor: ActorContext
  },
): Promise<ServiceResult<EvidenceRow>> {
  const access = await requirePilotAccess(deps, args.pilotId, args.actor)
  if (isErr(access)) return access
  // Measurements must carry a stable metric_key AND a structured value, so a
  // subjective note can never be filed as an objective measurement. A
  // metric_key on a non-measurement row is rejected (matches the DB constraint).
  if (args.category === 'measurement') {
    if (!args.metricKey) return fail('measurement_requires_metric_key')
    if (args.valueNumeric == null && !nonEmpty(args.valueText)) return fail('measurement_requires_value')
  } else if (args.metricKey) {
    return fail('metric_key_only_on_measurement')
  }
  const row = await deps.store.insertEvidence({
    pilot_id: args.pilotId,
    category: args.category,
    metric_key: args.metricKey ?? null,
    label: args.label ?? null,
    value_numeric: args.valueNumeric ?? null,
    value_text: args.valueText ?? null,
    unit: args.unit ?? null,
    observed_at: args.observedAt ?? null,
    provenance: args.provenance ?? null,
    author: args.actor.actingUserId,
  })
  return ok(row)
}

// ─── Generations + acceptance ────────────────────────────────────────────────

export async function recordGeneration(
  deps: PilotDeps,
  args: {
    pilotId: string
    source?: string | null
    kind?: string | null
    externalRef?: string | null
    label?: string | null
    notes?: string | null
    provenance?: Record<string, unknown> | null
    actor: ActorContext
  },
): Promise<ServiceResult<GenerationRow>> {
  const access = await requirePilotAccess(deps, args.pilotId, args.actor)
  if (isErr(access)) return access
  const row = await deps.store.insertGeneration({
    pilot_id: args.pilotId,
    source: args.source ?? null,
    kind: args.kind ?? null,
    external_ref: args.externalRef ?? null,
    label: args.label ?? null,
    notes: args.notes ?? null,
    provenance: args.provenance ?? null,
    author: args.actor.actingUserId,
  })
  return ok(row)
}

/**
 * Explicit, attributed human acceptance/rejection. Nothing is accepted by
 * default; an acceptance records the accepting human + timestamp. Authorization
 * is workspace-scoped (derived from the pilot the generation belongs to) and
 * never relies on message/button visibility.
 */
export async function decideGenerationAcceptance(
  deps: PilotDeps,
  args: { generationId: string; accept: boolean; actor: ActorContext },
): Promise<ServiceResult<null>> {
  const gen = await deps.store.getGenerationById(args.generationId)
  if (!gen) return fail('generation_not_found')
  const access = await requirePilotAccess(deps, gen.pilot_id, args.actor)
  if (isErr(access)) return access
  if (access.value.status !== 'active') return fail('pilot_not_active')
  await deps.store.setGenerationAcceptance(args.generationId, {
    acceptance: args.accept ? 'accepted' : 'rejected',
    accepted_by: args.actor.actingUserId,
    accepted_at: deps.now(),
  })
  return ok(null)
}

// ─── Material maps ───────────────────────────────────────────────────────────

export async function recordMaterialMap(
  deps: PilotDeps,
  args: {
    pilotId: string
    packageName: string
    mapType: MaterialMapType
    purpose: string
    externalRef?: string | null
    provenance?: Record<string, unknown> | null
    actor: ActorContext
  },
): Promise<ServiceResult<MaterialMapRow>> {
  const access = await requirePilotAccess(deps, args.pilotId, args.actor)
  if (isErr(access)) return access
  if (!nonEmpty(args.packageName)) return fail('package_name_required')
  // Every map must state a production purpose (also NOT NULL/non-empty in the DB).
  if (!nonEmpty(args.purpose)) return fail('purpose_required')
  const row = await deps.store.insertMaterialMap({
    pilot_id: args.pilotId,
    package_name: args.packageName,
    map_type: args.mapType,
    purpose: args.purpose,
    external_ref: args.externalRef ?? null,
    provenance: args.provenance ?? null,
    author: args.actor.actingUserId,
  })
  return ok(row)
}

// ─── Technical validation ────────────────────────────────────────────────────

export async function recordValidation(
  deps: PilotDeps,
  args: {
    pilotId: string
    tool: ValidationTool
    evidenceRef: string
    passed: boolean
    subject?: string | null
    note?: string | null
    provenance?: Record<string, unknown> | null
    actor: ActorContext
  },
): Promise<ServiceResult<ValidationRow>> {
  const access = await requirePilotAccess(deps, args.pilotId, args.actor)
  if (isErr(access)) return access
  // Technical validity requires RECORDED evidence (also NOT NULL/non-empty in DB).
  if (!nonEmpty(args.evidenceRef)) return fail('evidence_ref_required')
  const row = await deps.store.insertValidation({
    pilot_id: args.pilotId,
    tool: args.tool,
    evidence_ref: args.evidenceRef,
    passed: args.passed,
    subject: args.subject ?? null,
    note: args.note ?? null,
    provenance: args.provenance ?? null,
    author: args.actor.actingUserId,
  })
  return ok(row)
}

// ─── Finalization (completeness-gated) ───────────────────────────────────────

export async function finalizeRecommendation(
  deps: PilotDeps,
  args: {
    pilotId: string
    recommendation: string
    rationale: string | null
    actor: ActorContext
  },
): Promise<ServiceResult<PilotRow> & { finalize?: FinalizeDecision }> {
  const access = await requirePilotAccess(deps, args.pilotId, args.actor)
  if (isErr(access)) return access
  const snapshot = await deps.store.loadSnapshot(args.pilotId)
  if (!snapshot) return fail('pilot_not_found')

  const decision = decideFinalize(snapshot, args.recommendation)
  if (isBlocked(decision)) {
    return { ...fail('finalize_blocked', decision), finalize: decision }
  }

  // The recommendation is entered by the authorized human and simply persisted —
  // never generated or chosen by a model.
  await deps.store.updatePilot(args.pilotId, {
    status: 'finalized',
    recommendation: decision.recommendation,
    recommendation_rationale: args.rationale,
    recommendation_by: args.actor.actingUserId,
    recommendation_at: deps.now(),
  })
  const updated = await deps.store.getPilotById(args.pilotId)
  return ok(updated as PilotRow)
}

// ─── Canvas projection ───────────────────────────────────────────────────────

/**
 * Deterministically (re)render the pilot's dedicated read-only Canvas from the
 * authoritative snapshot. Creates the canvas on first render, edits it
 * thereafter — the canvas identity is persisted on the pilot row. Authorized
 * like every other operation (a foreign workspace cannot render/show a pilot).
 */
export async function refreshPilotCanvas(
  deps: PilotDeps,
  args: { pilotId: string; channelId: string; actor: ActorContext },
): Promise<ServiceResult<{ canvasId: string; canvasUrl: string | null }>> {
  const access = await requirePilotAccess(deps, args.pilotId, args.actor)
  if (isErr(access)) return access
  const snapshot = await deps.store.loadSnapshot(args.pilotId)
  if (!snapshot) return fail('pilot_not_found')
  const markdown = renderPilotCanvas(snapshot)
  const title = pilotCanvasTitle(snapshot.pilot.title || 'Pilot')
  // A Canvas (Slack) failure must never corrupt authoritative pilot state or
  // throw out of the operator path: catch it and return a typed failure so the
  // pilot row is untouched and a retry is safe. On an EDIT failure the bound
  // canvas_id is preserved (retry re-edits); on a CREATE failure canvas_id
  // stays null (retry re-creates) — never a duplicate binding.
  if (snapshot.pilot.canvas_id) {
    try {
      await deps.canvas.editPilotCanvas({ canvasId: snapshot.pilot.canvas_id, title, markdown })
    } catch (err) {
      return fail('canvas_edit_failed', (err as Error).message)
    }
    return ok({ canvasId: snapshot.pilot.canvas_id, canvasUrl: snapshot.pilot.canvas_url })
  }
  let handle: { canvasId: string; canvasUrl: string | null }
  try {
    handle = await deps.canvas.createPilotCanvas({ channelId: args.channelId, title, markdown })
  } catch (err) {
    return fail('canvas_create_failed', (err as Error).message)
  }
  await deps.store.updatePilot(args.pilotId, { canvas_id: handle.canvasId, canvas_url: handle.canvasUrl })
  return ok(handle)
}

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0
}
