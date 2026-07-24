/**
 * Pilots — read-only operator diagnostics (Workstreams 1-3).
 *
 * Deterministic. Creates/changes NO pilot state. Reuses the authoritative owners
 * (evaluateCompleteness, computePilotMetrics, isValidMeasurement, authorize) —
 * it never re-implements a rule. Three concerns:
 *   1. runtime + schema + project readiness  (runPilotReadiness)
 *   2. completeness explanation               (explainCompleteness)
 *   3. status / audit view                    (buildPilotStatus)
 *
 * Output is structured data; the Slack/CLI adapters render concise, secret-safe
 * text from it. Nothing here reads or prints secret VALUES — only presence.
 */

import { computePilotMetrics, type PilotMetrics } from './metrics'
import { evaluateCompleteness, isValidMeasurement, type CompletenessResult } from './completeness'
import { authorizePilotAction, type AuthDecision } from './transitions'
import type { PilotDeps } from './service'
import {
  REQUIRED_MEASUREMENT_KEYS,
  UNIT_REQUIRED_MEASUREMENT_KEYS,
  type EvidenceCategory,
  type PilotRecommendation,
  type PilotSnapshot,
  type ReferenceType,
  type ValidationTool,
  visualDevPilotEnabled,
} from './types'

// ─── Shared status vocabulary ────────────────────────────────────────────────

export type ReadyStatus = 'ready' | 'blocked' | 'missing_human_input' | 'unavailable' | 'error'

export interface Check {
  key: string
  status: ReadyStatus
  detail: string
}

/**
 * Operator-safe failure detail. Logs the RAW error (message/query text/provider
 * payload/identifiers) to the internal runtime log only, and returns a stable,
 * secret-free string for the user-facing Check. Never let a caught DB/provider
 * error string reach Slack output (operator-output safety invariant).
 */
function safeErrorDetail(scope: string, err: unknown): string {
  console.error(`[pilots] ${scope} error:`, (err as Error)?.message ?? err)
  return `${scope} failed — see runtime logs`
}

// ─── 1. Readiness ─────────────────────────────────────────────────────────────

/** Env vars the pilot runtime needs. Presence only — never the value. */
const REQUIRED_ENV = [
  'SLACK_BOT_TOKEN',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'KIT_DEFAULT_WORKSPACE_ID',
] as const

export function evaluateRuntimeReadiness(env: NodeJS.ProcessEnv): Check[] {
  const checks: Check[] = []
  const enabled = visualDevPilotEnabled(env)
  checks.push({
    key: 'feature_gate',
    status: enabled ? 'ready' : 'blocked',
    detail: enabled
      ? 'VISUAL_DEV_PILOT_ENABLED=true (pilot commands active)'
      : 'VISUAL_DEV_PILOT_ENABLED is false/absent (expected before activation)',
  })
  for (const name of REQUIRED_ENV) {
    const present = typeof env[name] === 'string' && env[name]!.trim().length > 0
    checks.push({
      key: `env:${name}`,
      status: present ? 'ready' : 'blocked',
      detail: present ? 'present' : 'missing',
    })
  }
  return checks
}

export interface ProjectEligibilityInput {
  exists: boolean
  status: string | null
  workspaceId: string | null
  slackChannelId: string | null
  actorWorkspaceId: string
  activeVdPilotId: string | null
}

export function evaluateProjectEligibility(input: ProjectEligibilityInput): Check[] {
  const checks: Check[] = []
  if (!input.exists) {
    checks.push({ key: 'project_exists', status: 'blocked', detail: 'project not found' })
    return checks
  }
  checks.push({ key: 'project_exists', status: 'ready', detail: 'found' })
  checks.push({
    key: 'project_status',
    status: 'ready',
    detail: `status=${input.status ?? 'unknown'} (suitability for active work is a human judgment)`,
  })
  checks.push(
    input.workspaceId === input.actorWorkspaceId
      ? { key: 'workspace_match', status: 'ready', detail: 'project workspace matches actor' }
      : { key: 'workspace_match', status: 'blocked', detail: 'project belongs to a different workspace' },
  )
  checks.push(
    input.activeVdPilotId
      ? { key: 'active_pilot_collision', status: 'blocked', detail: `an active visual_development pilot already exists (${input.activeVdPilotId})` }
      : { key: 'active_pilot_collision', status: 'ready', detail: 'no active visual_development pilot' },
  )
  checks.push(
    input.slackChannelId
      ? { key: 'project_slack_channel', status: 'ready', detail: 'project has a stored Slack channel' }
      : { key: 'project_slack_channel', status: 'missing_human_input', detail: 'no Slack channel stored on the project — operator must supply one' },
  )
  return checks
}

/** Human-required inputs that no deterministic check can satisfy. */
export function humanRequiredInputs(): Check[] {
  const items: Array<[string, string]> = [
    ['representative_project_approval', 'Mission Control must approve the representative project'],
    ['responsible_artist', 'an accountable artist (Cinema 4D / Redshift capable) must be assigned'],
    ['producer_coordinator', 'a producer/coordinator should be named'],
    ['recommendation_owner', 'a human recommendation owner must be assigned'],
    ['slack_channel', 'the pilot Slack channel must be confirmed (bot present, can host a Canvas)'],
    ['evidence_conventions', 'Pinterest/Figma/Higgsfield/material/C4D/Redshift storage conventions must be documented'],
    ['creative_tool_availability', 'Higgsfield / Cinema 4D / Redshift availability must be confirmed'],
  ]
  return items.map(([key, detail]) => ({ key, status: 'missing_human_input' as ReadyStatus, detail }))
}

export interface ReadinessReport {
  runtime: Check[]
  database: Check[]
  projectEligibility: Check[] | null
  humanInputs: Check[]
}

/**
 * Compose the full readiness report. Read-only: it only reads schema presence,
 * active-pilot count, and (if a projectId is given) project eligibility. Never
 * creates or mutates pilot state. DB errors degrade to 'unavailable'/'error'
 * checks rather than throwing.
 */
export async function runPilotReadiness(
  deps: PilotDeps,
  args: { projectId?: string; actorWorkspaceId: string; env?: NodeJS.ProcessEnv },
): Promise<ReadinessReport> {
  const env = args.env ?? process.env
  const runtime = evaluateRuntimeReadiness(env)

  const database: Check[] = []
  let schemaOk = false
  try {
    schemaOk = await deps.store.pilotSchemaPresent()
    database.push(
      schemaOk
        ? { key: 'pilot_schema', status: 'ready', detail: 'all pilot tables present and readable' }
        : { key: 'pilot_schema', status: 'unavailable', detail: 'pilot schema not present/readable (migration 058 not applied here?)' },
    )
  } catch (err) {
    database.push({ key: 'pilot_schema', status: 'error', detail: safeErrorDetail('pilot schema check', err) })
  }
  if (schemaOk) {
    try {
      const active = await deps.store.countActivePilots()
      database.push({ key: 'active_pilot_count', status: 'ready', detail: `${active} active pilot(s)` })
    } catch (err) {
      database.push({ key: 'active_pilot_count', status: 'error', detail: safeErrorDetail('active-pilot count', err) })
    }
  }

  let projectEligibility: Check[] | null = null
  if (args.projectId) {
    if (!schemaOk) {
      projectEligibility = [{ key: 'project_eligibility', status: 'unavailable', detail: 'schema unavailable — cannot evaluate' }]
    } else {
      try {
        const info = await deps.store.getProjectInfo(args.projectId)
        const active = info.exists ? await deps.store.getActivePilot(args.projectId, 'visual_development') : null
        projectEligibility = evaluateProjectEligibility({
          exists: info.exists,
          status: info.status,
          workspaceId: info.workspace_id,
          slackChannelId: info.slack_channel_id,
          actorWorkspaceId: args.actorWorkspaceId,
          activeVdPilotId: active?.id ?? null,
        })
      } catch (err) {
        projectEligibility = [{ key: 'project_eligibility', status: 'error', detail: safeErrorDetail('project eligibility', err) }]
      }
    }
  }

  return { runtime, database, projectEligibility, humanInputs: humanRequiredInputs() }
}

// ─── 2. Completeness explanation ──────────────────────────────────────────────

export type MeasurementState = 'ok' | 'invalid' | 'missing'

export interface CompletenessExplanation {
  complete: boolean
  /** The authoritative gate result (source of truth), unmodified. */
  result: CompletenessResult
  /** Missing requirements grouped for operator readability. */
  groups: Array<{ category: string; missing: Array<{ key: string; detail: string }> }>
  validations: { cinema4dPassed: boolean; redshiftPassed: boolean }
  measurements: Array<{ key: string; state: MeasurementState; unitRequired: boolean }>
  acceptedOutputs: number
  totalOutputs: number
  recommendationSupport: boolean
}

const CATEGORY_OF: Record<string, string> = {
  pinterest_reference: 'research',
  figma_moodboard: 'research',
  styleframe_direction: 'research',
  visual_language: 'research',
  generation_output: 'generation',
  accepted_output: 'generation',
  material_package: 'materials',
  cinema4d_validation: 'validation',
  redshift_validation: 'validation',
  assumptions_recorded: 'reflection',
  unknowns_recorded: 'reflection',
  recommendation_support: 'reflection',
}

function categoryFor(key: string): string {
  if (key.startsWith('measurement:')) return 'measurements'
  return CATEGORY_OF[key] ?? 'other'
}

/**
 * Explain completeness WITHOUT duplicating any rule — the missing list comes
 * straight from evaluateCompleteness; everything else is derived, read-only
 * detail (measurement missing-vs-malformed, per-tool validation, accepted
 * outputs, recommendation support).
 */
export function explainCompleteness(snapshot: PilotSnapshot): CompletenessExplanation {
  const result = evaluateCompleteness(snapshot)

  const byCat = new Map<string, Array<{ key: string; detail: string }>>()
  for (const m of result.missing) {
    const cat = categoryFor(m.key)
    if (!byCat.has(cat)) byCat.set(cat, [])
    byCat.get(cat)!.push({ key: m.key, detail: m.detail })
  }
  const groups = [...byCat.entries()].map(([category, missing]) => ({ category, missing }))

  const measurements = REQUIRED_MEASUREMENT_KEYS.map((key) => {
    const rows = snapshot.evidence.filter((e) => e.category === 'measurement' && e.metric_key === key)
    let state: MeasurementState
    if (rows.some((r) => isValidMeasurement(r, key))) state = 'ok'
    else if (rows.length > 0) state = 'invalid' // present but malformed
    else state = 'missing'
    return { key, state, unitRequired: (UNIT_REQUIRED_MEASUREMENT_KEYS as readonly string[]).includes(key) }
  })

  return {
    complete: result.complete,
    result,
    groups,
    validations: {
      cinema4dPassed: snapshot.validations.some((v) => v.tool === 'cinema4d' && v.passed === true),
      redshiftPassed: snapshot.validations.some((v) => v.tool === 'redshift' && v.passed === true),
    },
    measurements,
    acceptedOutputs: snapshot.generations.filter((g) => g.acceptance === 'accepted').length,
    totalOutputs: snapshot.generations.length,
    recommendationSupport: snapshot.evidence.some((e) => e.category === 'decision'),
  }
}

// ─── 3. Status / audit view ───────────────────────────────────────────────────

export interface PilotStatusView {
  pilotId: string
  projectId: string
  workspaceId: string | null
  status: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
  canvas: { bound: boolean; canvasId: string | null; canvasUrl: string | null }
  referencesByType: Record<ReferenceType, number>
  evidenceByCategory: Record<EvidenceCategory, number>
  generations: { total: number; accepted: number; rejected: number; pending: number }
  materialPackages: number
  materialMaps: number
  validationsByTool: Record<ValidationTool, { passed: number; failed: number }>
  metrics: PilotMetrics
  completeness: CompletenessResult
  recommendation: PilotRecommendation | null
}

function countBy<T extends string>(keys: readonly T[], get: (k: T) => number): Record<T, number> {
  const out = {} as Record<T, number>
  for (const k of keys) out[k] = get(k)
  return out
}

/** Deterministically derive an operator status view from authoritative state. */
export function buildPilotStatus(snapshot: PilotSnapshot): PilotStatusView {
  const p = snapshot.pilot
  const gens = snapshot.generations
  return {
    pilotId: p.id,
    projectId: p.project_id,
    workspaceId: p.workspace_id,
    status: p.status,
    createdBy: p.created_by,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    canvas: { bound: !!p.canvas_id, canvasId: p.canvas_id, canvasUrl: p.canvas_url },
    referencesByType: countBy<ReferenceType>(
      ['pinterest', 'figma_moodboard', 'styleframe_direction', 'other'],
      (t) => snapshot.references.filter((r) => r.ref_type === t).length,
    ),
    evidenceByCategory: countBy<EvidenceCategory>(
      ['measurement', 'observation', 'judgment', 'assumption', 'unknown', 'risk', 'decision'],
      (c) => snapshot.evidence.filter((e) => e.category === c).length,
    ),
    generations: {
      total: gens.length,
      accepted: gens.filter((g) => g.acceptance === 'accepted').length,
      rejected: gens.filter((g) => g.acceptance === 'rejected').length,
      pending: gens.filter((g) => g.acceptance === 'pending').length,
    },
    materialPackages: new Set(snapshot.materialMaps.map((m) => m.package_name)).size,
    materialMaps: snapshot.materialMaps.length,
    validationsByTool: {
      cinema4d: {
        passed: snapshot.validations.filter((v) => v.tool === 'cinema4d' && v.passed).length,
        failed: snapshot.validations.filter((v) => v.tool === 'cinema4d' && !v.passed).length,
      },
      redshift: {
        passed: snapshot.validations.filter((v) => v.tool === 'redshift' && v.passed).length,
        failed: snapshot.validations.filter((v) => v.tool === 'redshift' && !v.passed).length,
      },
    },
    metrics: computePilotMetrics(gens),
    completeness: evaluateCompleteness(snapshot),
    recommendation: p.recommendation,
  }
}

/** Authorize a read-only diagnostic against a loaded pilot (workspace-scoped). */
export function authorizeRead(pilot: Parameters<typeof authorizePilotAction>[0], actor: { actingUserId: string; workspaceId: string }): AuthDecision {
  return authorizePilotAction(pilot, actor)
}
