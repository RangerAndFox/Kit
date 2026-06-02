/**
 * Brain Flagger tests — deterministic pieces only.
 *
 * Haiku-driven mistake-catch isn't unit-tested here (requires API key +
 * network); it gets exercised in real traffic.
 *
 * Run: npx tsx --test src/lib/brain/flagger.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDateFromBullet,
  findDueWatchlistItems,
  collectCanonicalFacts,
} from './flagger'
import { parseBrain } from './format'

const NOW = new Date('2026-06-01T12:00:00Z')

describe('parseDateFromBullet', () => {
  it('parses ISO YYYY-MM-DD', () => {
    const d = parseDateFromBullet('⚠️ 2026-06-22 — final delivery target.', NOW)
    assert.ok(d)
    assert.equal(d!.getFullYear(), 2026)
    assert.equal(d!.getMonth(), 5)
    assert.equal(d!.getDate(), 22)
  })

  it('parses "Month DD" with current-year inference', () => {
    const d = parseDateFromBullet('Delivery deadline: June 22, EOD.', NOW)
    assert.ok(d)
    assert.equal(d!.getMonth(), 5)
    assert.equal(d!.getDate(), 22)
    assert.equal(d!.getFullYear(), 2026)
  })

  it('rolls forward when the month/day already passed this year', () => {
    const today = new Date('2026-07-15T12:00:00Z')
    const d = parseDateFromBullet('Delivery: June 22.', today)
    assert.ok(d)
    assert.equal(d!.getFullYear(), 2027)
  })

  it('parses "Month DD, YYYY" with explicit year', () => {
    const d = parseDateFromBullet('Locked: October 1, 2027.', NOW)
    assert.ok(d)
    assert.equal(d!.getFullYear(), 2027)
    assert.equal(d!.getMonth(), 9)
  })

  it('returns null for bullets without dates', () => {
    assert.equal(parseDateFromBullet('Final mix sign-off pending.', NOW), null)
  })
})

const BRAIN_MD = `---
brain_id: proj-test
scope: project
revision: 1
---

# Brain — Test

## Operating context
- Delivery target: 2026-06-22, broadcast ProRes 422 HQ. <!-- src: sow:TEST -->
- Project code: TEST123. <!-- src: harvest:TEST -->

## Watchlist (deadlines & risks)
- No watchlist items yet. <!-- src: system -->
- ⚠️ 2026-06-03 — VO re-record must land or delivery slips. <!-- src: meeting:2026-05-28 -->
- Final mix sign-off needed by June 5. <!-- src: thread:C0/p1 -->
- Distant item: 2026-12-15 launch. <!-- src: pm -->

## Glossary / canonical IDs
- Hero SKU: asset ID 44017 (NOT 44071). <!-- src: thread:C0/p2 -->
- Project type: Motion Graphics. <!-- src: harvest:TEST -->
`

describe('findDueWatchlistItems', () => {
  it('returns dated items within lead window', () => {
    const brain = parseBrain(BRAIN_MD)
    const due = findDueWatchlistItems(brain, { leadDays: 7, now: NOW })
    const texts = due.map((d) => d.text)
    assert.ok(texts.some((t) => /VO re-record/.test(t)))
    assert.ok(texts.some((t) => /June 5/.test(t)))
    // Far-future item should be excluded
    assert.ok(!texts.some((t) => /2026-12-15/.test(t)))
  })

  it('skips system placeholder bullets', () => {
    const brain = parseBrain(BRAIN_MD)
    const due = findDueWatchlistItems(brain, { leadDays: 30, now: NOW })
    assert.ok(!due.some((d) => /No watchlist items/i.test(d.text)))
  })

  it('flags past-due items with negative daysUntil', () => {
    const future = new Date('2026-06-10T12:00:00Z')
    const brain = parseBrain(BRAIN_MD)
    const due = findDueWatchlistItems(brain, { leadDays: 3, now: future })
    const vo = due.find((d) => /VO re-record/.test(d.text))
    assert.ok(vo)
    assert.ok(vo!.daysUntil < 0)
  })

  it('itemKey is stable across runs for the same bullet', () => {
    const brain = parseBrain(BRAIN_MD)
    const a = findDueWatchlistItems(brain, { leadDays: 30, now: NOW })
    const b = findDueWatchlistItems(brain, { leadDays: 30, now: NOW })
    assert.deepEqual(
      a.map((x) => x.itemKey),
      b.map((x) => x.itemKey),
    )
  })
})

describe('collectCanonicalFacts', () => {
  it('pulls glossary bullets', () => {
    const brain = parseBrain(BRAIN_MD)
    const facts = collectCanonicalFacts(brain)
    assert.ok(facts.some((f) => /Hero SKU/.test(f.text)))
  })

  it('pulls spec-like Operating context bullets', () => {
    const brain = parseBrain(BRAIN_MD)
    const facts = collectCanonicalFacts(brain)
    assert.ok(facts.some((f) => /ProRes 422 HQ/.test(f.text)))
  })

  it('skips system-tagged bullets', () => {
    const brain = parseBrain(BRAIN_MD)
    const facts = collectCanonicalFacts(brain)
    assert.ok(!facts.some((f) => f.provenance?.src === 'system'))
  })

  it('does not pull non-spec Operating context lines', () => {
    const md = `---
brain_id: x
scope: project
revision: 1
---

## Operating context
- Client: Microsoft. <!-- src: harvest -->
- Status: active. <!-- src: harvest -->
- Delivery target: 2026-06-22, ProRes 422 HQ. <!-- src: sow -->
`
    const facts = collectCanonicalFacts(parseBrain(md))
    // Client/Status should not be canonical — only the spec line
    const specMatched = facts.filter((f) => /ProRes/.test(f.text))
    assert.equal(specMatched.length, 1)
    assert.ok(!facts.some((f) => /Client: Microsoft/.test(f.text)))
  })
})
