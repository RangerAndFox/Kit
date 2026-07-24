/**
 * Pilots — deterministic evidence-completeness gate.
 *
 * Pure, no I/O. This is the authoritative definition of "enough evidence to
 * finalize", enforced in the state-transition owner (transitions.ts / service),
 * NOT only in UI or prompt wording. A pilot cannot reach a final recommendation
 * state unless this function returns complete=true.
 *
 * The gate is keyed by pilot_type; only 'visual_development' exists today. Adding
 * a pilot type means adding its requirement set here — the mechanism generalizes,
 * the requirements do not leak into the schema.
 */

import {
  REQUIRED_MEASUREMENT_KEYS,
  UNIT_REQUIRED_MEASUREMENT_KEYS,
  type EvidenceRow,
  type PilotSnapshot,
  type PilotType,
} from './types'

export interface MissingRequirement {
  /** Stable machine key for the unmet requirement. */
  key: string
  /** Human-readable explanation of what is missing. */
  detail: string
}

export interface CompletenessResult {
  complete: boolean
  missing: MissingRequirement[]
}

/**
 * Evaluate whether a pilot has recorded every required evidence class. Every
 * required class produces a distinct MissingRequirement when absent, so the
 * caller can tell the artist exactly what remains.
 */
export function evaluateCompleteness(snapshot: PilotSnapshot): CompletenessResult {
  const type = snapshot.pilot.pilot_type
  switch (type) {
    case 'visual_development':
      return evaluateVisualDevelopment(snapshot)
    default:
      // Unknown type: refuse to certify completeness rather than pass by default.
      return {
        complete: false,
        missing: [{ key: 'unknown_pilot_type', detail: `No completeness definition for pilot_type '${type as string}'` }],
      }
  }
}

function evaluateVisualDevelopment(s: PilotSnapshot): CompletenessResult {
  const missing: MissingRequirement[] = []
  const refs = s.references
  const gens = s.generations

  // Pinterest research: at least one.
  if (!refs.some((r) => r.ref_type === 'pinterest')) {
    missing.push({ key: 'pinterest_reference', detail: 'At least one Pinterest research reference is required' })
  }

  // Exactly one designated Figma moodboard (the DB enforces "at most one"; the
  // gate enforces "exactly one" for finalization).
  const figma = refs.filter((r) => r.ref_type === 'figma_moodboard')
  if (figma.length !== 1) {
    missing.push({
      key: 'figma_moodboard',
      detail: `Exactly one designated Figma moodboard is required (found ${figma.length})`,
    })
  }

  // Visual-language definition (non-empty).
  if (!nonEmpty(s.pilot.visual_language)) {
    missing.push({ key: 'visual_language', detail: 'A visual-language definition is required' })
  }

  // At least one deliberately recorded styleframe direction.
  if (!refs.some((r) => r.ref_type === 'styleframe_direction')) {
    missing.push({ key: 'styleframe_direction', detail: 'At least one styleframe direction must be recorded' })
  }

  // At least one generation output.
  if (gens.length === 0) {
    missing.push({ key: 'generation_output', detail: 'At least one generation output is required' })
  }

  // At least one HUMAN-accepted usable output.
  if (!gens.some((g) => g.acceptance === 'accepted')) {
    missing.push({ key: 'accepted_output', detail: 'At least one human-accepted usable output is required' })
  }

  // At least one material package (a distinct package_name).
  const packages = new Set(s.materialMaps.map((m) => m.package_name))
  if (packages.size === 0) {
    missing.push({ key: 'material_package', detail: 'At least one material package is required' })
  }
  // Every recorded map carries a purpose — structurally guaranteed by the schema
  // (purpose NOT NULL + non-empty), so a map without a purpose cannot exist.

  // Cinema 4D / Redshift validation: at least one PASSED (passed === true)
  // record of each tool. A failed validation is still evidence (and still
  // renders), but it cannot satisfy finalization.
  if (!s.validations.some((v) => v.tool === 'cinema4d' && v.passed === true)) {
    missing.push({ key: 'cinema4d_validation', detail: 'A passing Cinema 4D validation is required' })
  }
  if (!s.validations.some((v) => v.tool === 'redshift' && v.passed === true)) {
    missing.push({ key: 'redshift_validation', detail: 'A passing Redshift validation is required' })
  }

  // Required objective measurements — each key must be satisfied by at least one
  // VALID measurement row. The gate independently re-verifies validity (metric
  // key, meaningful value, attribution, unit where appropriate) rather than
  // trusting that a stored measurement row is well-formed — so a malformed row
  // never counts toward completeness.
  for (const key of REQUIRED_MEASUREMENT_KEYS) {
    if (!s.evidence.some((e) => isValidMeasurement(e, key))) {
      missing.push({ key: `measurement:${key}`, detail: `A valid measurement '${key}' is required` })
    }
  }

  // Unresolved assumptions and unknowns MUST be explicitly recorded — even when
  // the correct value is "none identified". We require at least one evidence row
  // of each category so the artist has affirmatively addressed them (a "none
  // identified" row is a valid, explicit record).
  if (!s.evidence.some((e) => e.category === 'assumption')) {
    missing.push({ key: 'assumptions_recorded', detail: 'Assumptions must be explicitly recorded (use "none identified" if so)' })
  }
  if (!s.evidence.some((e) => e.category === 'unknown')) {
    missing.push({ key: 'unknowns_recorded', detail: 'Unknowns must be explicitly recorded (use "none identified" if so)' })
  }

  // Supporting evidence for the final recommendation: at least one 'decision'
  // evidence row capturing the rationale/support.
  if (!s.evidence.some((e) => e.category === 'decision')) {
    missing.push({
      key: 'recommendation_support',
      detail: 'Supporting evidence (a decision record) for the recommendation is required',
    })
  }

  return { complete: missing.length === 0, missing }
}

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Independent validity check for a required measurement row. A row satisfies a
 * required metric only when it is a measurement for that exact key, carries a
 * meaningful value (a finite number, or non-empty text), is attributed, and —
 * for dimensional metrics (time, cost) — carries a non-empty unit. This makes
 * the gate robust to malformed rows that may exist despite the DB constraints.
 */
export function isValidMeasurement(e: EvidenceRow, key: string): boolean {
  if (e.category !== 'measurement') return false
  if (e.metric_key !== key) return false
  const hasValue = (typeof e.value_numeric === 'number' && Number.isFinite(e.value_numeric)) || nonEmpty(e.value_text)
  if (!hasValue) return false
  if (!nonEmpty(e.author)) return false
  if ((UNIT_REQUIRED_MEASUREMENT_KEYS as readonly string[]).includes(key) && !nonEmpty(e.unit)) return false
  return true
}

/** All pilot types the gate understands — for tooling/tests. */
export const KNOWN_PILOT_TYPES: readonly PilotType[] = ['visual_development'] as const
