/**
 * Pure parser tests (table-driven). Run: npx tsx --test src/lib/pilots/parser.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePilotCommand, parseMeasurementValue } from './parser'

describe('parsePilotCommand — valid', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['', { type: 'help' }],
    ['help', { type: 'help' }],
    ['readiness', { type: 'readiness', projectId: null }],
    ['readiness proj-1', { type: 'readiness', projectId: 'proj-1' }],
    ['status p1', { type: 'status', pilotId: 'p1' }],
    ['check p1', { type: 'check', pilotId: 'p1' }],
    ['show p1', { type: 'show', pilotId: 'p1' }],
    ['create proj-1 :: My Title', { type: 'create', projectId: 'proj-1', title: 'My Title' }],
    ['create proj-1', { type: 'create', projectId: 'proj-1', title: null }],
    ['visual-language p1 :: bold neon', { type: 'visual-language', pilotId: 'p1', text: 'bold neon' }],
    ['ref p1 pinterest https://x :: grit', { type: 'ref', pilotId: 'p1', refType: 'pinterest', url: 'https://x', label: 'grit' }],
    ['ref p1 figma https://f :: mb', { type: 'ref', pilotId: 'p1', refType: 'figma_moodboard', url: 'https://f', label: 'mb' }],
    ['ref p1 styleframe - :: dir A', { type: 'ref', pilotId: 'p1', refType: 'styleframe_direction', url: null, label: 'dir A' }],
    ['generation p1 up://1 :: frame', { type: 'generation', pilotId: 'p1', externalRef: 'up://1', label: 'frame' }],
    ['generation p1 -', { type: 'generation', pilotId: 'p1', externalRef: null, label: null }],
    ['accept g1', { type: 'accept', generationId: 'g1' }],
    ['reject g1', { type: 'reject', generationId: 'g1' }],
    ['map p1 Steel albedo :: base color', { type: 'map', pilotId: 'p1', packageName: 'Steel', mapType: 'albedo', purpose: 'base color' }],
    ['validate p1 redshift pass r.exr :: subj', { type: 'validate', pilotId: 'p1', tool: 'redshift', passed: true, evidenceRef: 'r.exr', subject: 'subj' }],
    ['validate p1 cinema4d fail c.png', { type: 'validate', pilotId: 'p1', tool: 'cinema4d', passed: false, evidenceRef: 'c.png', subject: null }],
    ['finalize p1 adopt :: rationale', { type: 'finalize', pilotId: 'p1', recommendation: 'adopt', rationale: 'rationale' }],
  ]
  for (const [input, expected] of cases) {
    it(`parses: "${input}"`, () => {
      const r = parsePilotCommand(input)
      assert.equal(r.status, 'ok', r.status === 'error' ? r.message : '')
      assert.deepEqual(r.status === 'ok' ? r.command : null, expected)
    })
  }

  it('measurement evidence splits numeric value + unit', () => {
    const r = parsePilotCommand('evidence p1 measurement time :: artist time :: 3.5 h')
    assert.equal(r.status, 'ok')
    assert.deepEqual(r.status === 'ok' ? r.command : null, {
      type: 'evidence', pilotId: 'p1', category: 'measurement', metricKey: 'time',
      label: 'artist time', valueNumeric: 3.5, valueText: null, unit: 'h',
    })
  })

  it('non-measurement evidence keeps text and rejects a metric key', () => {
    const r = parsePilotCommand('evidence p1 judgment :: reads original :: feels fresh')
    assert.equal(r.status, 'ok')
    assert.equal(r.status === 'ok' && r.command.type === 'evidence' && r.command.metricKey, null)
  })
})

describe('parsePilotCommand — errors (no side effects, stable usage)', () => {
  const errs: Array<[string, RegExp]> = [
    ['create', /projectId is required/],
    ['status', /pilotId is required/],
    ['ref p1 bogus https://x', /ref type must be one of/],
    ['ref p1 pinterest -', /requires a URL/],
    ['map p1 Steel bogus :: p', /map type must be one of/],
    ['validate p1 blender pass e', /tool must be one of/],
    ['validate p1 redshift maybe e', /result must be/],
    ['validate p1 redshift pass', /evidenceRef is required/],
    ['evidence p1 bogus :: l', /category must be one of/],
    ['evidence p1 measurement :: l :: 1', /requires a metricKey/],
    ['finalize p1 ship :: r', /recommendation must be one of/],
    ['frobnicate x', /unknown subcommand/],
  ]
  for (const [input, re] of errs) {
    it(`rejects: "${input}"`, () => {
      const r = parsePilotCommand(input)
      assert.equal(r.status, 'error')
      assert.match(r.status === 'error' ? r.message : '', re)
      assert.ok(r.status === 'error' && r.usage.length > 0, 'usage present')
    })
  }
})

describe('parseMeasurementValue', () => {
  it('parses numeric + unit', () => assert.deepEqual(parseMeasurementValue('12 hours'), { valueNumeric: 12, valueText: null, unit: 'hours' }))
  it('parses bare number', () => assert.deepEqual(parseMeasurementValue('7'), { valueNumeric: 7, valueText: null, unit: null }))
  it('falls back to text', () => assert.deepEqual(parseMeasurementValue('high'), { valueNumeric: null, valueText: 'high', unit: null }))
  it('handles null', () => assert.deepEqual(parseMeasurementValue(null), { valueNumeric: null, valueText: null, unit: null }))
})
