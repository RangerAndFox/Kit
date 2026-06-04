/**
 * Tests for fillCanvasTemplate against the real R&F template structure.
 *
 * Run: npx tsx --test src/lib/mcp/fill-canvas-template.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fillCanvasTemplate } from './slack'

// Verbatim-ish slice of the real template metadata table + a couple of
// rows that MUST NOT be matched (Client Figma, Delivery milestone).
const TEMPLATE = `# 🎬 2xxx Client Project

| ### **Client** |  |
| ### **Contacts** |  |
| ### **Project Type** |  |
| ### **Producer** |  |
| ### **CD** |  |
| ### **Delivery** |  |
| ### **VO** |  |

## Figma

| ### **Client Figma** |  |
| ### Internal Figma |  |

## Milestones

| Milestone | Date | Link |
| --- | --- | --- |
| Delivery | 2026-05-01 | — |
`

describe('fillCanvasTemplate', () => {
  const out = fillCanvasTemplate(TEMPLATE, {
    client: 'Nike',
    projectType: 'Brand Video',
    producer: '<@U123>',
    cd: '<@U456>',
    delivery: '2026-07-04',
    headerTitle: '3000_Nike_Pizza Sizzle',
  })

  it('fills Client', () => {
    assert.match(out, /\|\s*### \*\*Client\*\*\s*\|\s*Nike\s*\|/)
  })
  it('fills Project Type', () => {
    assert.match(out, /\|\s*### \*\*Project Type\*\*\s*\|\s*Brand Video\s*\|/)
  })
  it('fills Producer with a mention', () => {
    assert.match(out, /\|\s*### \*\*Producer\*\*\s*\|\s*<@U123>\s*\|/)
  })
  it('fills CD with a mention', () => {
    assert.match(out, /\|\s*### \*\*CD\*\*\s*\|\s*<@U456>\s*\|/)
  })
  it('fills Delivery (metadata row, not the milestone)', () => {
    assert.match(out, /\|\s*### \*\*Delivery\*\*\s*\|\s*2026-07-04\s*\|/)
  })

  it('replaces the placeholder H1', () => {
    assert.match(out, /# 🎬 3000_Nike_Pizza Sizzle/)
    assert.doesNotMatch(out, /2xxx Client Project/)
  })

  it('does NOT fill Client Figma', () => {
    assert.match(out, /\|\s*### \*\*Client Figma\*\*\s*\|\s*\|/)
  })

  it('does NOT overwrite the Delivery milestone (already has —)', () => {
    assert.match(out, /\|\s*Delivery\s*\|\s*2026-05-01\s*\|\s*—\s*\|/)
  })

  it('leaves Contacts / VO empty (no value supplied)', () => {
    assert.match(out, /\|\s*### \*\*Contacts\*\*\s*\|\s*\|/)
    assert.match(out, /\|\s*### \*\*VO\*\*\s*\|\s*\|/)
  })

  it('is a no-op when no fields supplied', () => {
    const same = fillCanvasTemplate(TEMPLATE, {})
    assert.equal(same, TEMPLATE)
  })
})
