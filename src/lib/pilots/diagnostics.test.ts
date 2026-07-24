/**
 * Diagnostics tests. Run: npx tsx --test src/lib/pilots/diagnostics.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPilotStatus,
  evaluateProjectEligibility,
  evaluateRuntimeReadiness,
  explainCompleteness,
  runPilotReadiness,
} from './diagnostics'
import { makeFakeCanvas, makeFakePilotStore } from './fake-store'
import { REQUIRED_MEASUREMENT_KEYS } from './types'
import type { EvidenceRow, GenerationRow, MaterialMapRow, PilotRow, PilotSnapshot, ReferenceRow, ValidationRow } from './types'

function pilot(over: Partial<PilotRow> = {}): PilotRow {
  return {
    id: 'p1', project_id: 'proj', workspace_id: 'ws', pilot_type: 'visual_development', title: 'T',
    status: 'active', visual_language: 'vl', recommendation: null, recommendation_rationale: null,
    recommendation_by: null, recommendation_at: null, canvas_id: null, canvas_url: null,
    created_by: 'U', created_at: 't', updated_at: 't', ...over,
  }
}
const ref = (t: ReferenceRow['ref_type']): ReferenceRow => ({ id: 'r' + t, pilot_id: 'p1', ref_type: t, url: 'u', label: null, description: null, provenance: null, author: 'U', created_at: 't' })
const gen = (a: GenerationRow['acceptance']): GenerationRow => ({ id: 'g' + a, pilot_id: 'p1', source: null, kind: null, external_ref: 'x', label: null, acceptance: a, accepted_by: a === 'accepted' ? 'U' : null, accepted_at: null, notes: null, provenance: null, author: 'U', created_at: 't' })
const meas = (k: string, over: Partial<EvidenceRow> = {}): EvidenceRow => ({ id: 'm' + k, pilot_id: 'p1', category: 'measurement', metric_key: k, label: k, value_numeric: 1, value_text: null, unit: 'u', observed_at: null, provenance: null, author: 'U', created_at: 't', ...over })
const ev = (c: EvidenceRow['category']): EvidenceRow => ({ id: 'e' + c, pilot_id: 'p1', category: c, metric_key: null, label: c, value_numeric: null, value_text: 'x', unit: null, observed_at: null, provenance: null, author: 'U', created_at: 't' })
const map = (): MaterialMapRow => ({ id: 'mm', pilot_id: 'p1', package_name: 'Steel', map_type: 'albedo', purpose: 'base', external_ref: null, provenance: null, author: 'U', created_at: 't' })
const val = (tool: ValidationRow['tool'], passed: boolean): ValidationRow => ({ id: 'v' + tool + passed, pilot_id: 'p1', tool, evidence_ref: 'r', subject: null, passed, note: null, provenance: null, author: 'U', created_at: 't' })

function completeSnap(): PilotSnapshot {
  return {
    pilot: pilot(),
    references: [ref('pinterest'), ref('figma_moodboard'), ref('styleframe_direction')],
    generations: [gen('accepted'), gen('rejected')],
    materialMaps: [map()],
    validations: [val('cinema4d', true), val('redshift', true)],
    evidence: [...REQUIRED_MEASUREMENT_KEYS.map((k) => meas(k)), ev('assumption'), ev('unknown'), ev('decision')],
  }
}

describe('evaluateRuntimeReadiness', () => {
  it('reports gate + env presence without values', () => {
    const checks = evaluateRuntimeReadiness({ VISUAL_DEV_PILOT_ENABLED: 'true', SLACK_BOT_TOKEN: 'x', NEXT_PUBLIC_SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', KIT_DEFAULT_WORKSPACE_ID: 'x' } as unknown as NodeJS.ProcessEnv)
    assert.equal(checks.find((c) => c.key === 'feature_gate')?.status, 'ready')
    assert.ok(checks.every((c) => !c.detail.includes('x')), 'no secret values leaked')
  })
  it('flags missing env + disabled gate', () => {
    const checks = evaluateRuntimeReadiness({} as unknown as NodeJS.ProcessEnv)
    assert.equal(checks.find((c) => c.key === 'feature_gate')?.status, 'blocked')
    assert.equal(checks.find((c) => c.key === 'env:SLACK_BOT_TOKEN')?.status, 'blocked')
  })
})

describe('evaluateProjectEligibility', () => {
  it('ready project matches workspace, no collision, has channel', () => {
    const checks = evaluateProjectEligibility({ exists: true, status: 'active', workspaceId: 'ws', slackChannelId: 'C1', actorWorkspaceId: 'ws', activeVdPilotId: null })
    assert.equal(checks.find((c) => c.key === 'workspace_match')?.status, 'ready')
    assert.equal(checks.find((c) => c.key === 'project_slack_channel')?.status, 'ready')
  })
  it('flags cross-workspace, collision, and missing channel', () => {
    const checks = evaluateProjectEligibility({ exists: true, status: 'active', workspaceId: 'ws', slackChannelId: null, actorWorkspaceId: 'other', activeVdPilotId: 'p9' })
    assert.equal(checks.find((c) => c.key === 'workspace_match')?.status, 'blocked')
    assert.equal(checks.find((c) => c.key === 'active_pilot_collision')?.status, 'blocked')
    assert.equal(checks.find((c) => c.key === 'project_slack_channel')?.status, 'missing_human_input')
  })
  it('missing project short-circuits', () => {
    const checks = evaluateProjectEligibility({ exists: false, status: null, workspaceId: null, slackChannelId: null, actorWorkspaceId: 'ws', activeVdPilotId: null })
    assert.equal(checks[0].key, 'project_exists')
    assert.equal(checks[0].status, 'blocked')
  })
})

describe('buildPilotStatus', () => {
  it('derives counts + zero-output rate explicitly', () => {
    const s = buildPilotStatus({ ...completeSnap(), generations: [] })
    assert.equal(s.generations.total, 0)
    assert.equal(s.metrics.usableOutputRate, null)
    assert.equal(s.materialPackages, 1)
    assert.equal(s.validationsByTool.cinema4d.passed, 1)
  })
  it('counts references + accepted outputs', () => {
    const s = buildPilotStatus(completeSnap())
    assert.equal(s.referencesByType.pinterest, 1)
    assert.equal(s.generations.accepted, 1)
    assert.equal(s.generations.rejected, 1)
    assert.equal(s.metrics.usableOutputRate, 0.5)
  })
})

describe('explainCompleteness', () => {
  it('complete snapshot → ready, both validations passing', () => {
    const x = explainCompleteness(completeSnap())
    assert.equal(x.complete, true)
    assert.equal(x.validations.cinema4dPassed, true)
    assert.equal(x.validations.redshiftPassed, true)
    assert.ok(x.measurements.every((m) => m.state === 'ok'))
  })
  it('distinguishes malformed (invalid) from missing measurements', () => {
    const s = completeSnap()
    // time present but malformed (no unit → invalid for a unit-required key); cost removed entirely.
    s.evidence = s.evidence.filter((e) => e.metric_key !== 'time' && e.metric_key !== 'cost')
    s.evidence.push(meas('time', { unit: null }))
    const x = explainCompleteness(s)
    assert.equal(x.measurements.find((m) => m.key === 'time')?.state, 'invalid')
    assert.equal(x.measurements.find((m) => m.key === 'cost')?.state, 'missing')
    assert.equal(x.complete, false)
  })
  it('failed validation is not counted as passing', () => {
    const s = completeSnap()
    s.validations = [val('cinema4d', false), val('redshift', true)]
    const x = explainCompleteness(s)
    assert.equal(x.validations.cinema4dPassed, false)
    assert.ok(x.groups.some((g) => g.category === 'validation'))
  })
})

describe('runPilotReadiness (orchestration)', () => {
  function deps() {
    const store = makeFakePilotStore()
    store.projectInfos['proj'] = { status: 'active', workspace_id: 'ws', slack_channel_id: 'C1' }
    return { store, canvas: makeFakeCanvas(), now: () => 't' }
  }
  it('reports schema present + project eligibility + human inputs', async () => {
    const d = deps()
    const r = await runPilotReadiness(d, { projectId: 'proj', actorWorkspaceId: 'ws', env: { VISUAL_DEV_PILOT_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv })
    assert.equal(r.database.find((c) => c.key === 'pilot_schema')?.status, 'ready')
    assert.ok(r.projectEligibility && r.projectEligibility.length > 0)
    assert.ok(r.humanInputs.every((c) => c.status === 'missing_human_input'))
  })
  it('degrades to unavailable when schema is absent', async () => {
    const d = deps()
    d.store.schemaPresent = false
    const r = await runPilotReadiness(d, { projectId: 'proj', actorWorkspaceId: 'ws', env: {} as unknown as NodeJS.ProcessEnv })
    assert.equal(r.database.find((c) => c.key === 'pilot_schema')?.status, 'unavailable')
    assert.equal(r.projectEligibility?.[0].status, 'unavailable')
  })
})
