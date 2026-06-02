/**
 * Round-trip tests for brain format.
 *
 * Run: npx tsx --test src/lib/brain/format.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBrain,
  serializeBrain,
  parseProvenanceComment,
  applyPatch,
  stripProvenance,
  buildBrainId,
  ensureSection,
  findSection,
  pruneSystemPlaceholders,
} from './format'

const CANONICAL = `---
brain_id: proj-studio100-ignite25
scope: project
project_code: STUDIO100
slack_channel: C0123ABCD
updated: 2026-06-01T14:30:00Z
revision: 47
---

# Brain — Microsoft Ignite 2025 (STUDIO100)

## Operating context
- Client: Microsoft. Producer: Brad S. Editor: TBD. <!-- src: harvest:proj/STUDIO100 -->
- Delivery target: 2026-06-20, broadcast ProRes 422 HQ. <!-- src: sow:STUDIO100 conf: 0.9 -->

## Open decisions
- [ ] Final lower-third font — Priya to confirm. <!-- src: meeting:2026-05-28 -->
- [x] Hero shot locked. <!-- src: thread:C0123/p1718 by: @brad -->

## Glossary / canonical IDs
- Hero SKU for this campaign: asset ID 44017 (NOT 44071). <!-- src: thread:C0123/p1719 -->
`

describe('parseProvenanceComment', () => {
  it('parses all three fields', () => {
    const r = parseProvenanceComment('Foo bar. <!-- src: x:y conf: 0.85 by: @brad -->')
    assert.equal(r.text, 'Foo bar.')
    assert.deepEqual(r.provenance, { src: 'x:y', conf: 0.85, by: '@brad' })
  })

  it('parses just src', () => {
    const r = parseProvenanceComment('Hello. <!-- src: thread:C0/p1 -->')
    assert.equal(r.text, 'Hello.')
    assert.deepEqual(r.provenance, { src: 'thread:C0/p1' })
  })

  it('returns no provenance when no comment', () => {
    const r = parseProvenanceComment('Plain bullet text')
    assert.equal(r.text, 'Plain bullet text')
    assert.equal(r.provenance, undefined)
  })

  it('handles src values with colons and slashes', () => {
    const r = parseProvenanceComment('x <!-- src: harvest:proj/STUDIO100 -->')
    assert.equal(r.provenance?.src, 'harvest:proj/STUDIO100')
  })
})

describe('parseBrain', () => {
  it('reads frontmatter, title, sections, bullets', () => {
    const b = parseBrain(CANONICAL)
    assert.equal(b.frontmatter.brain_id, 'proj-studio100-ignite25')
    assert.equal(b.frontmatter.scope, 'project')
    assert.equal(b.frontmatter.revision, 47)
    assert.equal(b.title, 'Brain — Microsoft Ignite 2025 (STUDIO100)')
    assert.equal(b.sections.length, 3)
    assert.equal(b.sections[0].heading, 'Operating context')
    assert.equal(b.sections[0].bullets.length, 2)
    assert.equal(b.sections[0].bullets[0].text, 'Client: Microsoft. Producer: Brad S. Editor: TBD.')
    assert.equal(b.sections[0].bullets[0].provenance?.src, 'harvest:proj/STUDIO100')
    assert.equal(b.sections[1].bullets[0].checked, false)
    assert.equal(b.sections[1].bullets[1].checked, true)
  })
})

describe('round-trip', () => {
  it('serialize(parse(x)) === x for canonical input', () => {
    const out = serializeBrain(parseBrain(CANONICAL))
    assert.equal(out, CANONICAL)
  })

  it('parse(serialize(parse(x))) is structurally equal to parse(x)', () => {
    const a = parseBrain(CANONICAL)
    const b = parseBrain(serializeBrain(a))
    assert.deepEqual(b, a)
  })
})

describe('applyPatch', () => {
  it('add appends to existing section', () => {
    const b = parseBrain(CANONICAL)
    applyPatch(b, { section: 'Open decisions', operation: 'add', text: 'Audio mix sign-off', checked: false })
    const decisions = findSection(b, 'Open decisions')!
    assert.equal(decisions.bullets.length, 3)
    assert.equal(decisions.bullets[2].text, 'Audio mix sign-off')
    assert.equal(decisions.bullets[2].checked, false)
  })

  it('add creates a new section when missing', () => {
    const b = parseBrain(CANONICAL)
    applyPatch(b, { section: 'Watchlist', operation: 'add', text: 'VO re-record by Friday' })
    assert.ok(findSection(b, 'Watchlist'))
  })

  it('update replaces a matched bullet in-place', () => {
    const b = parseBrain(CANONICAL)
    applyPatch(b, {
      section: 'Glossary / canonical IDs',
      operation: 'update',
      text: 'Hero SKU: asset ID 44017. (NOT 44071. Burned us in May.)',
      match: 'hero sku',
    })
    const gl = findSection(b, 'Glossary / canonical IDs')!
    assert.equal(gl.bullets.length, 1)
    assert.match(gl.bullets[0].text, /Burned us in May/)
  })

  it('supersede strikes the old bullet and appends the new', () => {
    const b = parseBrain(CANONICAL)
    applyPatch(b, {
      section: 'Operating context',
      operation: 'supersede',
      text: 'Delivery target: 2026-06-22 (slipped two days).',
      match: 'delivery target',
    })
    const op = findSection(b, 'Operating context')!
    assert.equal(op.bullets.length, 3)
    assert.match(op.bullets[1].text, /^~~/)
    assert.match(op.bullets[2].text, /slipped two days/)
  })
})

describe('stripProvenance', () => {
  it('removes HTML-comment tails from each line', () => {
    const stripped = stripProvenance(CANONICAL)
    assert.doesNotMatch(stripped, /<!--/)
    assert.match(stripped, /Hero SKU for this campaign: asset ID 44017 \(NOT 44071\)\./)
  })
})

describe('buildBrainId', () => {
  it('builds proj-<code>-<slug>', () => {
    assert.equal(buildBrainId({ scope: 'project', projectCode: 'STUDIO100', slug: 'Ignite 2025' }), 'proj-studio100-ignite-2025')
  })
  it('returns "studio" for the workspace brain', () => {
    assert.equal(buildBrainId({ scope: 'studio' }), 'studio')
  })
})

describe('ensureSection', () => {
  it('is case-insensitive for matching', () => {
    const b = parseBrain(CANONICAL)
    const s = ensureSection(b, 'OPEN DECISIONS')
    assert.equal(s.heading, 'Open decisions')
    assert.equal(b.sections.length, 3)
  })
})

describe('placeholder stripping', () => {
  const SEEDED = `---
brain_id: test
scope: project
revision: 1
---

## Recent decisions (log)
- No decisions logged yet. <!-- src: system -->

## Watchlist (deadlines & risks)
- No watchlist items yet. <!-- src: system -->
- Delivery: 2026-06-22. <!-- src: sow:TEST -->
`

  it('add removes the system placeholder when a real bullet lands', () => {
    const b = parseBrain(SEEDED)
    applyPatch(b, {
      section: 'Recent decisions (log)',
      operation: 'add',
      text: 'Locked the hero shot.',
      provenance: { src: 'thread:C0/p1' },
    })
    const decisions = findSection(b, 'Recent decisions (log)')!
    assert.equal(decisions.bullets.length, 1)
    assert.equal(decisions.bullets[0].text, 'Locked the hero shot.')
  })

  it('preserves the placeholder if the new patch is itself a system bullet', () => {
    const b = parseBrain(SEEDED)
    applyPatch(b, {
      section: 'Recent decisions (log)',
      operation: 'add',
      text: 'Auto-imported placeholder.',
      provenance: { src: 'system' },
    })
    const decisions = findSection(b, 'Recent decisions (log)')!
    assert.equal(decisions.bullets.length, 2)
  })

  it('does not strip if the section already has only real bullets', () => {
    const b = parseBrain(SEEDED)
    // Watchlist already has 1 real bullet + 1 placeholder. Adding another
    // real bullet should strip the placeholder.
    applyPatch(b, {
      section: 'Watchlist (deadlines & risks)',
      operation: 'add',
      text: '⚠️ VO re-record by Friday.',
      provenance: { src: 'meeting:2026-05-28' },
    })
    const watch = findSection(b, 'Watchlist (deadlines & risks)')!
    assert.equal(watch.bullets.length, 2)
    assert.ok(!watch.bullets.some((b) => b.provenance?.src === 'system'))
  })

  it('pruneSystemPlaceholders cleans every applicable section', () => {
    const b = parseBrain(SEEDED)
    const { removed } = pruneSystemPlaceholders(b)
    assert.equal(removed, 1) // only Watchlist had a real bullet beside the placeholder
    assert.ok(!findSection(b, 'Watchlist (deadlines & risks)')!.bullets.some((x) => x.provenance?.src === 'system'))
    // The placeholder-only section stays as-is (its placeholder is the only entry — strip would empty the section)
    assert.equal(findSection(b, 'Recent decisions (log)')!.bullets.length, 1)
  })
})
