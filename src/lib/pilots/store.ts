/**
 * Supabase-owned durable state for Pilots (migration 058). Supabase is the
 * authoritative source; every derived value is recomputed elsewhere.
 *
 * The generated `Database` type predates migration 058, so DB access goes
 * through a narrow typed facade (`SupabaseLike`) — the same pattern as
 * project-control/store.ts — until types are regenerated post-migration. Every
 * exported function is fully typed. This module contains ONLY thin persistence;
 * all orchestration/guards live in service.ts and the pure modules, so the
 * guarantees are unit-tested through injected fakes rather than a live DB.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type {
  EvidenceRow,
  GenerationRow,
  MaterialMapRow,
  PilotRow,
  PilotSnapshot,
  ReferenceRow,
  ValidationRow,
} from './types'

const nowIso = () => new Date().toISOString()

// ─── Narrow Supabase facade (tables not yet in generated types) ──────────────

interface QueryResult {
  data: unknown
  error: { message: string } | null
}

interface FilterBuilder extends PromiseLike<QueryResult> {
  select(cols?: string): FilterBuilder
  eq(col: string, val: unknown): FilterBuilder
  order(col: string, opts?: { ascending?: boolean }): FilterBuilder
  maybeSingle(): Promise<QueryResult>
  single(): Promise<QueryResult>
}
interface TableBuilder {
  select(cols?: string): FilterBuilder
  insert(values: Record<string, unknown>): FilterBuilder
  update(values: Record<string, unknown>): FilterBuilder
}
interface SupabaseLike {
  from(table: string): TableBuilder
}

let clientFactory: () => unknown = createAdminClient

/** Test seam: swap the Supabase client factory for a fake. Pass null to restore. */
export function __setPilotStoreClientForTests(f: (() => unknown) | null): void {
  clientFactory = f || createAdminClient
}

function db(): SupabaseLike {
  return clientFactory() as unknown as SupabaseLike
}

// ─── Project (authoritative workspace lookup) ────────────────────────────────

/** The authoritative workspace of an existing project (for create auth). */
export async function getProjectWorkspaceId(projectId: string): Promise<string | null> {
  const { data } = await db().from('projects').select('workspace_id').eq('id', projectId).maybeSingle()
  const row = data as { workspace_id?: string | null } | null
  return row?.workspace_id ?? null
}

/** Deterministic project facts the readiness diagnostic needs (read-only). */
export interface ProjectInfo {
  exists: boolean
  status: string | null
  workspace_id: string | null
  slack_channel_id: string | null
}

export async function getProjectInfo(projectId: string): Promise<ProjectInfo> {
  const { data } = await db()
    .from('projects')
    .select('status, workspace_id, slack_channel_id')
    .eq('id', projectId)
    .maybeSingle()
  const row = data as { status?: string | null; workspace_id?: string | null; slack_channel_id?: string | null } | null
  if (!row) return { exists: false, status: null, workspace_id: null, slack_channel_id: null }
  return {
    exists: true,
    status: row.status ?? null,
    workspace_id: row.workspace_id ?? null,
    slack_channel_id: row.slack_channel_id ?? null,
  }
}

/**
 * Whether the pilot schema is present + readable. Returns false on ANY error
 * (missing table, permission) so the diagnostic reports "schema unavailable"
 * rather than throwing — the operator-facing signal, not a crash.
 */
export async function pilotSchemaPresent(): Promise<boolean> {
  const { error } = await db().from('pilots').select('id').eq('id', ZERO_UUID).maybeSingle()
  return !error
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

/** Count of active (non-terminal) pilots across the workspace (diagnostic). */
export async function countActivePilots(): Promise<number> {
  const { data, error } = await db().from('pilots').select('id').eq('status', 'active')
  if (error) throw new Error(`countActivePilots: ${error.message}`)
  return ((data as unknown[]) || []).length
}

// ─── Pilot record ────────────────────────────────────────────────────────────

export async function insertPilot(values: {
  project_id: string
  workspace_id: string | null
  pilot_type: string
  title: string | null
  created_by: string | null
}): Promise<PilotRow> {
  const { data, error } = await db()
    .from('pilots')
    .insert({ ...values, status: 'active' })
    .select()
    .single()
  if (error) throw new Error(`insertPilot: ${error.message}`)
  return data as PilotRow
}

export async function getPilotById(id: string): Promise<PilotRow | null> {
  const { data } = await db().from('pilots').select('*').eq('id', id).maybeSingle()
  return (data as PilotRow) || null
}

/** The active (non-terminal) pilot of a type for a project, if any. */
export async function getActivePilot(projectId: string, pilotType: string): Promise<PilotRow | null> {
  const { data } = await db()
    .from('pilots')
    .select('*')
    .eq('project_id', projectId)
    .eq('pilot_type', pilotType)
    .eq('status', 'active')
    .maybeSingle()
  return (data as PilotRow) || null
}

export async function updatePilot(id: string, patch: Partial<PilotRow>): Promise<void> {
  const { error } = await db()
    .from('pilots')
    .update({ ...patch, updated_at: nowIso() })
    .eq('id', id)
  if (error) throw new Error(`updatePilot: ${error.message}`)
}

// ─── Child inserts (append-only from the store's perspective) ────────────────

export async function insertReference(values: Omit<ReferenceRow, 'id' | 'created_at'>): Promise<ReferenceRow> {
  const { data, error } = await db().from('pilot_references').insert({ ...values }).select().single()
  if (error) throw new Error(`insertReference: ${error.message}`)
  return data as ReferenceRow
}

export async function insertEvidence(values: Omit<EvidenceRow, 'id' | 'created_at'>): Promise<EvidenceRow> {
  const { data, error } = await db().from('pilot_evidence').insert({ ...values }).select().single()
  if (error) throw new Error(`insertEvidence: ${error.message}`)
  return data as EvidenceRow
}

export async function insertGeneration(
  values: Omit<GenerationRow, 'id' | 'created_at' | 'acceptance' | 'accepted_by' | 'accepted_at'>,
): Promise<GenerationRow> {
  const { data, error } = await db()
    .from('pilot_generations')
    .insert({ ...values, acceptance: 'pending' })
    .select()
    .single()
  if (error) throw new Error(`insertGeneration: ${error.message}`)
  return data as GenerationRow
}

export async function getGenerationById(id: string): Promise<GenerationRow | null> {
  const { data } = await db().from('pilot_generations').select('*').eq('id', id).maybeSingle()
  return (data as GenerationRow) || null
}

/**
 * Apply an acceptance decision. This is the ONLY mutation the DB permits on a
 * generation (trigger-enforced): acceptance + accepted_by + accepted_at.
 */
export async function setGenerationAcceptance(
  id: string,
  patch: { acceptance: 'accepted' | 'rejected'; accepted_by: string | null; accepted_at: string | null },
): Promise<void> {
  const { error } = await db().from('pilot_generations').update(patch).eq('id', id)
  if (error) throw new Error(`setGenerationAcceptance: ${error.message}`)
}

export async function insertMaterialMap(values: Omit<MaterialMapRow, 'id' | 'created_at'>): Promise<MaterialMapRow> {
  const { data, error } = await db().from('pilot_material_maps').insert({ ...values }).select().single()
  if (error) throw new Error(`insertMaterialMap: ${error.message}`)
  return data as MaterialMapRow
}

export async function insertValidation(values: Omit<ValidationRow, 'id' | 'created_at'>): Promise<ValidationRow> {
  const { data, error } = await db().from('pilot_validations').insert({ ...values }).select().single()
  if (error) throw new Error(`insertValidation: ${error.message}`)
  return data as ValidationRow
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

async function listChildren<T>(table: string, pilotId: string): Promise<T[]> {
  // Deterministic order so rendering + hashing are stable across reads.
  const { data, error } = await db()
    .from(table)
    .select('*')
    .eq('pilot_id', pilotId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) throw new Error(`list ${table}: ${error.message}`)
  return (data as T[]) || []
}

/** Load the full authoritative snapshot for metrics/completeness/rendering. */
export async function loadSnapshot(pilotId: string): Promise<PilotSnapshot | null> {
  const pilot = await getPilotById(pilotId)
  if (!pilot) return null
  const [references, evidence, generations, materialMaps, validations] = await Promise.all([
    listChildren<ReferenceRow>('pilot_references', pilotId),
    listChildren<EvidenceRow>('pilot_evidence', pilotId),
    listChildren<GenerationRow>('pilot_generations', pilotId),
    listChildren<MaterialMapRow>('pilot_material_maps', pilotId),
    listChildren<ValidationRow>('pilot_validations', pilotId),
  ])
  return { pilot, references, evidence, generations, materialMaps, validations }
}
