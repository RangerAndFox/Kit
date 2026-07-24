/**
 * Shared Pilots types + configuration.
 *
 * A pilot is a bounded, evidence-driven experiment attached to ONE existing Kit
 * project (migration 058). Supabase is authoritative; any Slack Canvas is a
 * deterministic read-only projection. The visual-development workflow is one
 * `pilot_type`, not a new abstraction family — everything generic lives here.
 */

// ─── Enums (mirror the migration-058 check constraints) ──────────────────────

export type PilotType = 'visual_development'
export type PilotStatus = 'active' | 'finalized' | 'abandoned'
export type PilotRecommendation = 'adopt' | 'revise' | 'repeat' | 'discontinue'

export type EvidenceCategory =
  | 'measurement'
  | 'observation'
  | 'judgment'
  | 'assumption'
  | 'unknown'
  | 'risk'
  | 'decision'

export type GenerationAcceptance = 'pending' | 'accepted' | 'rejected'

export type ReferenceType = 'pinterest' | 'figma_moodboard' | 'styleframe_direction' | 'other'

export type MaterialMapType =
  | 'albedo'
  | 'roughness'
  | 'normal'
  | 'height'
  | 'displacement'
  | 'metalness'
  | 'ao'
  | 'opacity'
  | 'other'

export type ValidationTool = 'cinema4d' | 'redshift'

export const PILOT_RECOMMENDATIONS: readonly PilotRecommendation[] = [
  'adopt',
  'revise',
  'repeat',
  'discontinue',
] as const

export const EVIDENCE_CATEGORIES: readonly EvidenceCategory[] = [
  'measurement',
  'observation',
  'judgment',
  'assumption',
  'unknown',
  'risk',
  'decision',
] as const

/**
 * The objective measurements the visual-development completeness gate requires.
 * Stored as pilot_evidence rows with category='measurement' and these
 * metric_keys. Kept here (not only in the gate) so producers and the gate agree
 * on one list.
 */
export const REQUIRED_MEASUREMENT_KEYS: readonly string[] = [
  'time',
  'cost',
  'output_count',
  'cleanup',
  'originality',
  'editability',
  'continuity',
  'quality',
  'reuse_willingness',
] as const

/**
 * Dimensional measurements for which a bare number is ambiguous, so the
 * completeness gate additionally requires a non-empty unit. The rating-style
 * metrics (originality, quality, …) are legitimately unitless and are not listed.
 */
export const UNIT_REQUIRED_MEASUREMENT_KEYS: readonly string[] = ['time', 'cost'] as const

// ─── Row shapes ──────────────────────────────────────────────────────────────

export interface PilotRow {
  id: string
  project_id: string
  workspace_id: string | null
  pilot_type: PilotType
  title: string | null
  status: PilotStatus
  visual_language: string | null
  recommendation: PilotRecommendation | null
  recommendation_rationale: string | null
  recommendation_by: string | null
  recommendation_at: string | null
  canvas_id: string | null
  canvas_url: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface EvidenceRow {
  id: string
  pilot_id: string
  category: EvidenceCategory
  metric_key: string | null
  label: string | null
  value_numeric: number | null
  value_text: string | null
  unit: string | null
  observed_at: string | null
  provenance: Record<string, unknown> | null
  author: string
  created_at: string
}

export interface GenerationRow {
  id: string
  pilot_id: string
  source: string | null
  kind: string | null
  external_ref: string | null
  label: string | null
  acceptance: GenerationAcceptance
  accepted_by: string | null
  accepted_at: string | null
  notes: string | null
  provenance: Record<string, unknown> | null
  author: string
  created_at: string
}

export interface ReferenceRow {
  id: string
  pilot_id: string
  ref_type: ReferenceType
  url: string | null
  label: string | null
  description: string | null
  provenance: Record<string, unknown> | null
  author: string
  created_at: string
}

export interface MaterialMapRow {
  id: string
  pilot_id: string
  package_name: string
  map_type: MaterialMapType
  purpose: string
  external_ref: string | null
  provenance: Record<string, unknown> | null
  author: string
  created_at: string
}

export interface ValidationRow {
  id: string
  pilot_id: string
  tool: ValidationTool
  evidence_ref: string
  subject: string | null
  passed: boolean
  note: string | null
  provenance: Record<string, unknown> | null
  author: string
  created_at: string
}

/**
 * The full deterministic input to metrics, completeness, and rendering. Every
 * derived value is computed from this snapshot — never stored authoritatively.
 */
export interface PilotSnapshot {
  pilot: PilotRow
  references: ReferenceRow[]
  evidence: EvidenceRow[]
  generations: GenerationRow[]
  materialMaps: MaterialMapRow[]
  validations: ValidationRow[]
}

// ─── Feature gate ────────────────────────────────────────────────────────────

/**
 * Reversible gate for the whole Pilots capability. When false, the pilot
 * commands/handlers are inert and no pilot state is created. Independent of any
 * Project Control gate — this mission never alters project creation.
 */
export function visualDevPilotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VISUAL_DEV_PILOT_ENABLED === 'true'
}
