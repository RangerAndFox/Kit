/**
 * Deterministic Canvas render tests.
 *
 * Run: npx tsx --test src/lib/pilots/render.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderPilotCanvas, PILOT_GENERATED_VIEW_NOTICE } from './render'
import type { GenerationRow, PilotRow, PilotSnapshot } from './types'

function snap(over: Partial<PilotSnapshot> = {}): PilotSnapshot {
  const pilot: PilotRow = {
    id: 'p', project_id: 'proj', workspace_id: 'ws', pilot_type: 'visual_development', title: 'Ignite',
    status: 'active', visual_language: 'Tactile neon.', recommendation: null, recommendation_rationale: null,
    recommendation_by: null, recommendation_at: null, canvas_id: null, canvas_url: null,
    created_by: 'u', created_at: 't', updated_at: 't',
  }
  return { pilot, references: [], evidence: [], generations: [], materialMaps: [], validations: [], ...over }
}

function gen(a: GenerationRow['acceptance']): GenerationRow {
  return { id: 'g' + a, pilot_id: 'p', source: null, kind: 'styleframe', external_ref: 'ref', label: 'frame', acceptance: a, accepted_by: a === 'accepted' ? 'U123' : null, accepted_at: null, notes: null, provenance: null, author: 'u', created_at: 't' }
}

describe('renderPilotCanvas', () => {
  it('leads with the generated-view notice', () => {
    const md = renderPilotCanvas(snap())
    assert.ok(md.startsWith(PILOT_GENERATED_VIEW_NOTICE))
  })

  it('is deterministic (same snapshot → identical markdown)', () => {
    const s = snap({ generations: [gen('accepted'), gen('rejected')] })
    assert.equal(renderPilotCanvas(s), renderPilotCanvas(s))
  })

  it('keeps evidence categories in distinct sections', () => {
    const md = renderPilotCanvas(snap())
    for (const heading of [
      '## Measured Results',
      '## Observations',
      '## Artist Judgments',
      '## Assumptions',
      '## Unknowns',
      '## Risks',
      '## Technical Validation (Cinema 4D / Redshift)',
      '## Final Decision',
    ]) {
      assert.ok(md.includes(heading), `missing section: ${heading}`)
    }
  })

  it('reports usable-output rate from the deterministic metrics owner', () => {
    const md = renderPilotCanvas(snap({ generations: [gen('accepted'), gen('rejected')] }))
    assert.ok(md.includes('Usable-output rate:** 50.0%'))
  })

  it('shows "no outputs" rate as n/a rather than 0%', () => {
    const md = renderPilotCanvas(snap())
    assert.ok(md.includes('n/a (no outputs recorded)'))
  })

  it('renders a finalized recommendation traceable to its author + support', () => {
    const s = snap({
      pilot: { ...snap().pilot, status: 'finalized', recommendation: 'adopt', recommendation_by: 'U777', recommendation_rationale: 'Fast, editable, on-brand.' },
      evidence: [{ id: 'd', pilot_id: 'p', category: 'decision', metric_key: null, label: 'Support', value_numeric: null, value_text: 'Cost fell 40%.', unit: null, observed_at: null, provenance: null, author: 'U777', created_at: 't' }],
    })
    const md = renderPilotCanvas(s)
    assert.ok(md.includes('Recommendation:** ADOPT'))
    assert.ok(md.includes('U777'))
    assert.ok(md.includes('Cost fell 40%.'))
  })
})
