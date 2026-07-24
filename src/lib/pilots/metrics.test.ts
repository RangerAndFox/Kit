/**
 * Deterministic derived-metric tests.
 *
 * Run: npx tsx --test src/lib/pilots/metrics.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computePilotMetrics, formatUsableOutputRate } from './metrics'
import type { GenerationRow } from './types'

function gen(acceptance: GenerationRow['acceptance']): GenerationRow {
  return {
    id: 'g',
    pilot_id: 'p',
    source: null,
    kind: null,
    external_ref: null,
    label: null,
    acceptance,
    accepted_by: null,
    accepted_at: null,
    notes: null,
    provenance: null,
    author: 'u',
    created_at: 't',
  }
}

describe('computePilotMetrics', () => {
  it('returns usableOutputRate = null (not 0) for zero outputs', () => {
    const m = computePilotMetrics([])
    assert.equal(m.totalGenerations, 0)
    assert.equal(m.usableGenerations, 0)
    assert.equal(m.usableOutputRate, null)
    assert.equal(formatUsableOutputRate(m.usableOutputRate), 'n/a (no outputs recorded)')
  })

  it('computes usable / total deterministically', () => {
    const m = computePilotMetrics([gen('accepted'), gen('accepted'), gen('rejected'), gen('pending')])
    assert.equal(m.totalGenerations, 4)
    assert.equal(m.usableGenerations, 2)
    assert.equal(m.rejectedGenerations, 1)
    assert.equal(m.pendingGenerations, 1)
    assert.equal(m.usableOutputRate, 0.5)
    assert.equal(formatUsableOutputRate(m.usableOutputRate), '50.0%')
  })

  it('all-rejected yields 0 rate, not null (there was a denominator)', () => {
    const m = computePilotMetrics([gen('rejected'), gen('rejected')])
    assert.equal(m.usableOutputRate, 0)
    assert.equal(formatUsableOutputRate(m.usableOutputRate), '0.0%')
  })
})
