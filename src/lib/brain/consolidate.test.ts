/**
 * Brain Consolidator tests — deterministic pieces only.
 *
 * The Haiku dedupe pass isn't unit-tested (requires API key + network).
 *
 * Run: npx tsx --test src/lib/brain/consolidate.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ageOutWatchlist, compressDecisionsLog } from './consolidate'
import { parseBrain, findSection } from './format'

const NOW = new Date('2026-07-01T12:00:00Z')

describe('ageOutWatchlist', () => {
  const MD = `---
brain_id: test
scope: project
revision: 1
---

## Watchlist (deadlines & risks)
- ⚠️ 2026-06-01 — VO re-record. <!-- src: meeting -->
- ⚠️ 2026-06-22 — final delivery target. <!-- src: sow -->
- ⚠️ 2026-07-15 — launch event. <!-- src: cal -->
- Open-ended risk: client may pivot brief. <!-- src: thread:C0/p1 -->
- No watchlist items yet. <!-- src: system -->
`

  it('removes items past the grace window', () => {
    const brain = parseBrain(MD)
    const res = ageOutWatchlist(brain, { graceDays: 7, now: NOW })
    // 2026-06-01 is 30 days past — removed. 2026-06-22 is 9 days past — removed.
    // 2026-07-15 is in future — kept. Undated risk — kept. System — kept.
    assert.equal(res.removed.length, 2)
    const watch = findSection(brain, 'Watchlist (deadlines & risks)')!
    assert.equal(watch.bullets.length, 3)
    assert.ok(watch.bullets.some((b) => b.text.includes('2026-07-15')))
    assert.ok(watch.bullets.some((b) => b.text.includes('client may pivot')))
    assert.ok(watch.bullets.some((b) => b.provenance?.src === 'system'))
  })

  it('preserves all bullets when none are past the grace window', () => {
    const earlyNow = new Date('2026-05-15T12:00:00Z')
    const brain = parseBrain(MD)
    const res = ageOutWatchlist(brain, { graceDays: 7, now: earlyNow })
    assert.equal(res.removed.length, 0)
  })

  it('honors a longer grace window', () => {
    const brain = parseBrain(MD)
    const res = ageOutWatchlist(brain, { graceDays: 365, now: NOW })
    assert.equal(res.removed.length, 0)
  })

  it('never removes system placeholders even when dated past', () => {
    const md = `---
brain_id: test
scope: project
revision: 1
---

## Watchlist (deadlines & risks)
- No watchlist items yet. <!-- src: system -->
`
    const brain = parseBrain(md)
    const res = ageOutWatchlist(brain, { graceDays: 1, now: NOW })
    assert.equal(res.removed.length, 0)
  })
})

describe('compressDecisionsLog', () => {
  const buildLog = (n: number) => {
    const bullets: string[] = []
    bullets.push('- No decisions logged yet. <!-- src: system -->')
    for (let i = 1; i <= n; i++) {
      const day = String(i).padStart(2, '0')
      bullets.push(`- 2026-06-${day}: decision ${i}. <!-- src: thread:C0/p${i} -->`)
    }
    return `---
brain_id: test
scope: project
revision: 1
---

## Recent decisions (log)
${bullets.join('\n')}
`
  }

  it('keeps the most-recent N decisions and moves the rest to Earlier', () => {
    const brain = parseBrain(buildLog(25))
    const res = compressDecisionsLog(brain, { keepRecent: 10 })
    assert.equal(res.moved, 15)
    const live = findSection(brain, 'Recent decisions (log)')!
    // 10 real + 1 system placeholder
    assert.equal(live.bullets.length, 11)
    const earlier = findSection(brain, 'Earlier decisions')
    assert.ok(earlier)
    assert.equal(earlier!.bullets.length, 15)
  })

  it('keeps the most-recent dates in the live log', () => {
    const brain = parseBrain(buildLog(25))
    compressDecisionsLog(brain, { keepRecent: 5 })
    const live = findSection(brain, 'Recent decisions (log)')!
    const real = live.bullets.filter((b) => b.provenance?.src !== 'system')
    assert.equal(real.length, 5)
    // The kept entries should be days 21..25
    assert.ok(real[0].text.startsWith('2026-06-21'))
    assert.ok(real[4].text.startsWith('2026-06-25'))
  })

  it('no-ops when log is under the keep threshold', () => {
    const brain = parseBrain(buildLog(5))
    const res = compressDecisionsLog(brain, { keepRecent: 20 })
    assert.equal(res.moved, 0)
  })
})
