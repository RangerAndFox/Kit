/**
 * Pure transition-guard + authorization tests.
 *
 * Run: npx tsx --test src/lib/pilots/transitions.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authorizePilotAction, decideFinalize, isValidRecommendation } from './transitions'
import { REQUIRED_MEASUREMENT_KEYS } from './types'
import type { EvidenceRow, GenerationRow, MaterialMapRow, PilotRow, PilotSnapshot, ReferenceRow, ValidationRow } from './types'

function basePilot(over: Partial<PilotRow> = {}): PilotRow {
  return {
    id: 'p', project_id: 'proj', workspace_id: 'ws', pilot_type: 'visual_development', title: 'T',
    status: 'active', visual_language: 'vl', recommendation: null, recommendation_rationale: null,
    recommendation_by: null, recommendation_at: null, canvas_id: null, canvas_url: null,
    created_by: 'u', created_at: 't', updated_at: 't', ...over,
  }
}

function complete(pilot: PilotRow): PilotSnapshot {
  const ref = (t: ReferenceRow['ref_type']): ReferenceRow => ({ id: 'r' + t, pilot_id: 'p', ref_type: t, url: 'u', label: null, description: null, provenance: null, author: 'u', created_at: 't' })
  const gen = (a: GenerationRow['acceptance']): GenerationRow => ({ id: 'g' + a, pilot_id: 'p', source: null, kind: null, external_ref: 'x', label: null, acceptance: a, accepted_by: a === 'accepted' ? 'u' : null, accepted_at: null, notes: null, provenance: null, author: 'u', created_at: 't' })
  const ev = (c: EvidenceRow['category'], k: string | null = null): EvidenceRow => ({ id: 'e' + c + (k ?? ''), pilot_id: 'p', category: c, metric_key: k, label: 'l', value_numeric: k ? 1 : null, value_text: k ? null : 'none', unit: k ? 'u' : null, observed_at: null, provenance: null, author: 'u', created_at: 't' })
  const map: MaterialMapRow = { id: 'm', pilot_id: 'p', package_name: 'pkg', map_type: 'albedo', purpose: 'base', external_ref: null, provenance: null, author: 'u', created_at: 't' }
  const val = (tool: ValidationRow['tool']): ValidationRow => ({ id: 'v' + tool, pilot_id: 'p', tool, evidence_ref: 'r', subject: null, passed: true, note: null, provenance: null, author: 'u', created_at: 't' })
  return {
    pilot,
    references: [ref('pinterest'), ref('figma_moodboard'), ref('styleframe_direction')],
    generations: [gen('accepted')],
    materialMaps: [map],
    validations: [val('cinema4d'), val('redshift')],
    evidence: [...REQUIRED_MEASUREMENT_KEYS.map((k) => ev('measurement', k)), ev('assumption'), ev('unknown'), ev('decision')],
  }
}

describe('authorizePilotAction', () => {
  it('rejects null / wrong workspace / missing actor; allows workspace match', () => {
    assert.equal(authorizePilotAction(null, { actingUserId: 'u', workspaceId: 'ws' }).ok, false)
    assert.equal(authorizePilotAction(basePilot(), { actingUserId: 'u', workspaceId: 'other' }).ok, false)
    assert.equal(authorizePilotAction(basePilot(), { actingUserId: '', workspaceId: 'ws' }).ok, false)
    assert.equal(authorizePilotAction(basePilot(), { actingUserId: 'u', workspaceId: 'ws' }).ok, true)
  })
})

describe('isValidRecommendation', () => {
  it('accepts only the four enum values', () => {
    for (const v of ['adopt', 'revise', 'repeat', 'discontinue']) assert.equal(isValidRecommendation(v), true)
    for (const v of ['approve', 'ship', '', 'ADOPT']) assert.equal(isValidRecommendation(v), false)
  })
})

describe('decideFinalize', () => {
  it('blocks when pilot already terminal', () => {
    const d = decideFinalize(complete(basePilot({ status: 'finalized' })), 'adopt')
    assert.equal(d.ok, false)
    assert.equal(d.ok === false && d.reason, 'already_terminal')
  })

  it('blocks an invalid recommendation even when evidence is complete', () => {
    const d = decideFinalize(complete(basePilot()), 'ship-it')
    assert.equal(d.ok, false)
    assert.equal(d.ok === false && d.reason, 'invalid_recommendation')
  })

  it('blocks when evidence is incomplete', () => {
    const s = complete(basePilot())
    s.generations = [] // remove all outputs
    const d = decideFinalize(s, 'adopt')
    assert.equal(d.ok, false)
    assert.equal(d.ok === false && d.reason, 'incomplete_evidence')
    assert.ok(d.ok === false && d.completeness && d.completeness.missing.length > 0)
  })

  it('permits finalization when complete + valid recommendation', () => {
    const d = decideFinalize(complete(basePilot()), 'adopt')
    assert.equal(d.ok, true)
    assert.equal(d.ok === true && d.recommendation, 'adopt')
  })
})
