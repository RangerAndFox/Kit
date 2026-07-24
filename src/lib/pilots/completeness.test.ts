/**
 * Evidence-completeness gate tests: a failure for every required class, and
 * success only when all evidence exists.
 *
 * Run: npx tsx --test src/lib/pilots/completeness.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCompleteness } from './completeness'
import { REQUIRED_MEASUREMENT_KEYS } from './types'
import type {
  EvidenceRow,
  GenerationRow,
  MaterialMapRow,
  PilotRow,
  PilotSnapshot,
  ReferenceRow,
  ValidationRow,
} from './types'

function pilot(over: Partial<PilotRow> = {}): PilotRow {
  return {
    id: 'p',
    project_id: 'proj',
    workspace_id: 'ws',
    pilot_type: 'visual_development',
    title: 'T',
    status: 'active',
    visual_language: 'Bold, high-contrast, tactile.',
    recommendation: null,
    recommendation_rationale: null,
    recommendation_by: null,
    recommendation_at: null,
    canvas_id: null,
    canvas_url: null,
    created_by: 'u',
    created_at: 't',
    updated_at: 't',
    ...over,
  }
}

function ref(ref_type: ReferenceRow['ref_type']): ReferenceRow {
  return { id: 'r' + ref_type, pilot_id: 'p', ref_type, url: 'https://x', label: null, description: null, provenance: null, author: 'u', created_at: 't' }
}
function gen(acceptance: GenerationRow['acceptance']): GenerationRow {
  return { id: 'g' + acceptance, pilot_id: 'p', source: null, kind: null, external_ref: 'x', label: null, acceptance, accepted_by: acceptance === 'accepted' ? 'u' : null, accepted_at: null, notes: null, provenance: null, author: 'u', created_at: 't' }
}
function measurement(metric_key: string): EvidenceRow {
  return { id: 'm' + metric_key, pilot_id: 'p', category: 'measurement', metric_key, label: metric_key, value_numeric: 1, value_text: null, unit: 'u', observed_at: 't', provenance: null, author: 'u', created_at: 't' }
}
function evidence(category: EvidenceRow['category'], sfx = ''): EvidenceRow {
  return { id: 'e' + category + sfx, pilot_id: 'p', category, metric_key: null, label: category, value_numeric: null, value_text: 'none identified', unit: null, observed_at: null, provenance: null, author: 'u', created_at: 't' }
}
function map(): MaterialMapRow {
  return { id: 'map1', pilot_id: 'p', package_name: 'RustedMetal', map_type: 'albedo', purpose: 'base color', external_ref: null, provenance: null, author: 'u', created_at: 't' }
}
function validation(tool: ValidationRow['tool']): ValidationRow {
  return { id: 'v' + tool, pilot_id: 'p', tool, evidence_ref: 'render.png', subject: null, passed: true, note: null, provenance: null, author: 'u', created_at: 't' }
}

function completeSnapshot(): PilotSnapshot {
  return {
    pilot: pilot(),
    references: [ref('pinterest'), ref('figma_moodboard'), ref('styleframe_direction')],
    generations: [gen('accepted'), gen('rejected')],
    materialMaps: [map()],
    validations: [validation('cinema4d'), validation('redshift')],
    evidence: [
      ...REQUIRED_MEASUREMENT_KEYS.map((k) => measurement(k)),
      evidence('assumption'),
      evidence('unknown'),
      evidence('decision'),
    ],
  }
}

describe('evaluateCompleteness (visual_development)', () => {
  it('passes when every required evidence class exists', () => {
    const res = evaluateCompleteness(completeSnapshot())
    assert.equal(res.complete, true, JSON.stringify(res.missing))
    assert.equal(res.missing.length, 0)
  })

  const removers: Array<[string, (s: PilotSnapshot) => void]> = [
    ['pinterest_reference', (s) => { s.references = s.references.filter((r) => r.ref_type !== 'pinterest') }],
    ['figma_moodboard', (s) => { s.references = s.references.filter((r) => r.ref_type !== 'figma_moodboard') }],
    ['visual_language', (s) => { s.pilot.visual_language = '   ' }],
    ['styleframe_direction', (s) => { s.references = s.references.filter((r) => r.ref_type !== 'styleframe_direction') }],
    ['generation_output', (s) => { s.generations = [] }],
    ['accepted_output', (s) => { s.generations = s.generations.filter((g) => g.acceptance !== 'accepted') }],
    ['material_package', (s) => { s.materialMaps = [] }],
    ['cinema4d_validation', (s) => { s.validations = s.validations.filter((v) => v.tool !== 'cinema4d') }],
    ['redshift_validation', (s) => { s.validations = s.validations.filter((v) => v.tool !== 'redshift') }],
    ['assumptions_recorded', (s) => { s.evidence = s.evidence.filter((e) => e.category !== 'assumption') }],
    ['unknowns_recorded', (s) => { s.evidence = s.evidence.filter((e) => e.category !== 'unknown') }],
    ['recommendation_support', (s) => { s.evidence = s.evidence.filter((e) => e.category !== 'decision') }],
    ['measurement:time', (s) => { s.evidence = s.evidence.filter((e) => e.metric_key !== 'time') }],
    ['measurement:quality', (s) => { s.evidence = s.evidence.filter((e) => e.metric_key !== 'quality') }],
  ]

  for (const [key, remove] of removers) {
    it(`blocks finalization when '${key}' is missing`, () => {
      const s = completeSnapshot()
      remove(s)
      const res = evaluateCompleteness(s)
      assert.equal(res.complete, false)
      assert.ok(res.missing.some((m) => m.key === key), `expected missing key ${key}, got ${JSON.stringify(res.missing.map((m) => m.key))}`)
    })
  }

  it('a second figma moodboard also fails the "exactly one" gate', () => {
    const s = completeSnapshot()
    s.references.push(ref('figma_moodboard'))
    const res = evaluateCompleteness(s)
    assert.equal(res.complete, false)
    assert.ok(res.missing.some((m) => m.key === 'figma_moodboard'))
  })

  it('every required measurement key is individually required', () => {
    for (const key of REQUIRED_MEASUREMENT_KEYS) {
      const s = completeSnapshot()
      s.evidence = s.evidence.filter((e) => e.metric_key !== key)
      const res = evaluateCompleteness(s)
      assert.ok(res.missing.some((m) => m.key === `measurement:${key}`), `missing ${key}`)
    }
  })
})

describe('completeness requires PASSING technical validation', () => {
  function withValidations(vals: ValidationRow[]): PilotSnapshot {
    const s = completeSnapshot()
    s.validations = vals
    return s
  }
  const fail = (tool: ValidationRow['tool']): ValidationRow => ({ ...validation(tool), passed: false })

  it('both failed → both tools missing', () => {
    const res = evaluateCompleteness(withValidations([fail('cinema4d'), fail('redshift')]))
    assert.ok(res.missing.some((m) => m.key === 'cinema4d_validation'))
    assert.ok(res.missing.some((m) => m.key === 'redshift_validation'))
  })

  it('one passed / one failed → the failed tool missing', () => {
    const res = evaluateCompleteness(withValidations([validation('cinema4d'), fail('redshift')]))
    assert.ok(!res.missing.some((m) => m.key === 'cinema4d_validation'))
    assert.ok(res.missing.some((m) => m.key === 'redshift_validation'))
  })

  it('both passed → neither tool missing', () => {
    const res = evaluateCompleteness(withValidations([validation('cinema4d'), validation('redshift')]))
    assert.ok(!res.missing.some((m) => m.key === 'cinema4d_validation'))
    assert.ok(!res.missing.some((m) => m.key === 'redshift_validation'))
  })

  it('a failed validation alongside a passing one still satisfies (evidence retained)', () => {
    const res = evaluateCompleteness(withValidations([validation('cinema4d'), fail('cinema4d'), validation('redshift')]))
    assert.equal(res.complete, true, JSON.stringify(res.missing))
  })
})

describe('completeness independently re-verifies measurement rows', () => {
  function withTimeMeasurement(over: Partial<EvidenceRow>): PilotSnapshot {
    const s = completeSnapshot()
    s.evidence = s.evidence.filter((e) => e.metric_key !== 'time')
    s.evidence.push({ ...measurement('time'), ...over })
    return s
  }

  it('rejects a measurement with no meaningful value', () => {
    const res = evaluateCompleteness(withTimeMeasurement({ value_numeric: null, value_text: '   ' }))
    assert.ok(res.missing.some((m) => m.key === 'measurement:time'))
  })

  it('rejects a measurement with no attribution', () => {
    const res = evaluateCompleteness(withTimeMeasurement({ author: '' }))
    assert.ok(res.missing.some((m) => m.key === 'measurement:time'))
  })

  it('rejects a dimensional measurement (time/cost) with no unit', () => {
    const res = evaluateCompleteness(withTimeMeasurement({ unit: null }))
    assert.ok(res.missing.some((m) => m.key === 'measurement:time'))
  })

  it('a mislabeled measurement (wrong metric_key) does not satisfy the requirement', () => {
    const s = completeSnapshot()
    s.evidence = s.evidence.filter((e) => e.metric_key !== 'time')
    s.evidence.push({ ...measurement('time'), metric_key: 'not_time' })
    const res = evaluateCompleteness(s)
    assert.ok(res.missing.some((m) => m.key === 'measurement:time'))
  })
})
