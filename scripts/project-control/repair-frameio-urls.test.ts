/**
 * Legacy Frame.io URL repair — planner is exact, id-preserving, idempotent, and
 * the utility writes NOTHING without --apply.
 *
 * Run: npx tsx --test scripts/project-control/repair-frameio-urls.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planFrameioUrlRepairs, LEGACY_FRAMEIO_PROJECT_URL, type FrameioUrlRepair } from './repair-frameio-urls'
import type { ColumnCell } from '../../src/lib/project-control/sheets'

const cell = (rowIndex: number, value: string, hyperlink: string | null = null): ColumnCell => ({ rowIndex, value, hyperlink })

describe('planFrameioUrlRepairs — exact legacy shape only', () => {
  it('rewrites the exact legacy URL, preserving the id, to the singular /project/ form', () => {
    const plan = planFrameioUrlRepairs([cell(3, 'https://app.frame.io/projects/abc-123')])
    assert.equal(plan.length, 1)
    assert.deepEqual(
      { rowNumber: plan[0].rowNumber, rowIndex: plan[0].rowIndex, oldUrl: plan[0].oldUrl, newUrl: plan[0].newUrl },
      { rowNumber: 4, rowIndex: 3, oldUrl: 'https://app.frame.io/projects/abc-123', newUrl: 'https://next.frame.io/project/abc-123' },
    )
  })

  it('reports the 1-based row number and preserves a UUID id verbatim', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    const plan = planFrameioUrlRepairs([cell(9, `https://app.frame.io/projects/${id}`)])
    assert.equal(plan[0].rowNumber, 10)
    assert.equal(plan[0].newUrl, `https://next.frame.io/project/${id}`)
  })

  it('trims surrounding whitespace but still matches only the exact shape', () => {
    const plan = planFrameioUrlRepairs([cell(3, '  https://app.frame.io/projects/xyz  ')])
    assert.equal(plan.length, 1)
    assert.equal(plan[0].newUrl, 'https://next.frame.io/project/xyz')
  })

  it('skips already-correct next.frame.io values (idempotent — a second run is a no-op)', () => {
    assert.deepEqual(planFrameioUrlRepairs([cell(3, 'https://next.frame.io/project/abc-123')]), [])
  })

  it('never rewrites non-project Frame.io links or arbitrary/blank values', () => {
    const rows = [
      cell(3, ''),
      cell(4, 'https://app.frame.io/reviews/deadbeef'), // review link — not a project
      cell(5, 'https://app.frame.io/shares/abc'),
      cell(6, 'https://app.frame.io/player/xyz'),
      cell(7, 'https://app.frame.io/projects/abc/view/file'), // trailing path — not exact
      cell(8, 'https://app.frame.io/projects/abc?x=1'), // query — not exact
      cell(9, 'see frame.io for details'),
      cell(10, 'https://example.com/projects/abc'),
    ]
    assert.deepEqual(planFrameioUrlRepairs(rows), [])
  })

  it('handles a mixed column, returning only the exact legacy matches', () => {
    const rows = [
      cell(3, 'https://app.frame.io/projects/one'),
      cell(4, 'https://next.frame.io/project/two'),
      cell(5, ''),
      cell(6, 'https://app.frame.io/projects/three'),
    ]
    const plan = planFrameioUrlRepairs(rows)
    assert.deepEqual(plan.map((p: FrameioUrlRepair) => p.rowNumber), [4, 7])
    assert.deepEqual(plan.map((p) => p.newUrl), ['https://next.frame.io/project/one', 'https://next.frame.io/project/three'])
  })
})

describe('LEGACY_FRAMEIO_PROJECT_URL regex', () => {
  it('matches the exact shape and captures the id', () => {
    const m = LEGACY_FRAMEIO_PROJECT_URL.exec('https://app.frame.io/projects/ID-9')
    assert.equal(m?.[1], 'ID-9')
  })
  it('does not match plural-path variants with extra segments or the new host', () => {
    assert.equal(LEGACY_FRAMEIO_PROJECT_URL.test('https://app.frame.io/projects/ID/extra'), false)
    assert.equal(LEGACY_FRAMEIO_PROJECT_URL.test('https://next.frame.io/project/ID'), false)
    assert.equal(LEGACY_FRAMEIO_PROJECT_URL.test('http://app.frame.io/projects/ID'), false)
  })
})
