/**
 * Tests for Project Control template structural-signature resolution.
 *
 * Run: npx tsx --test src/lib/project-control/template-signature.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasProjectControlSignature,
  resolveProjectControlTemplate,
} from './template-signature'

// The verified R&F Project Control structure (from fill-canvas-template.test.ts).
const CONTROL = `# 🎬 2xxx Client Project

| ### **Client** |  |
| ### **Contacts** |  |
| ### **Project Type** |  |
| ### **Producer** |  |
| ### **CD** |  |
| ### **Delivery** |  |
| ### **VO** |  |

## Assets Folders

| ### Dropbox |  |
| ### [Frame.io](http://Frame.io) |  |

## Milestones

| Milestone | Date | Link |
| --- | --- | --- |
| Delivery | 2026-05-01 | — |
`

// An unrelated operational canvas — a shot list. Must NOT match.
const SHOTLIST = `# Shot List

| Shot | Description | Status |
| --- | --- | --- |
| 1 | Wide establishing | todo |
`

describe('hasProjectControlSignature', () => {
  it('accepts the real Project Control structure', () => {
    assert.equal(hasProjectControlSignature(CONTROL), true)
  })

  it('rejects an unrelated canvas', () => {
    assert.equal(hasProjectControlSignature(SHOTLIST), false)
  })

  it('rejects a near-miss missing the Milestones section', () => {
    const noMilestones = CONTROL.split('## Milestones')[0]
    assert.equal(hasProjectControlSignature(noMilestones), false)
  })

  it('rejects a near-miss missing Frame.io / Assets Folders', () => {
    const noAssets = CONTROL.replace(/## Assets Folders[\s\S]*## Milestones/, '## Milestones')
    assert.equal(hasProjectControlSignature(noAssets), false)
  })
})

describe('resolveProjectControlTemplate', () => {
  it('returns the single matching candidate', () => {
    const r = resolveProjectControlTemplate([
      { fileId: 'F_SHOT', markdown: SHOTLIST },
      { fileId: 'F_CTRL', markdown: CONTROL },
    ])
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.fileId, 'F_CTRL')
  })

  it('fails closed with reason "none" when nothing matches', () => {
    const r = resolveProjectControlTemplate([{ fileId: 'F_SHOT', markdown: SHOTLIST }])
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.reason, 'none')
  })

  it('fails closed with reason "multiple" and lists ids when 2+ match', () => {
    const r = resolveProjectControlTemplate([
      { fileId: 'F_A', markdown: CONTROL },
      { fileId: 'F_B', markdown: CONTROL },
    ])
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.reason, 'multiple')
    assert.deepEqual(!r.ok && r.matchedFileIds, ['F_A', 'F_B'])
  })

  it('honors an explicit configured file id without structural matching', () => {
    const r = resolveProjectControlTemplate(
      [{ fileId: 'F_SHOT', markdown: SHOTLIST }, { fileId: 'F_CFG', markdown: SHOTLIST }],
      'F_CFG',
    )
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.fileId, 'F_CFG')
  })
})
