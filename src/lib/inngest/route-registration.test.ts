/**
 * Canonical Inngest registration coverage — STRUCTURAL (no source-text/regex).
 *
 * Imports the ONE canonical function list the route actually registers
 * (`inngestFunctions`) and the exact value it hands to `serve()`
 * (`registeredFunctions`), then drives the REAL function objects through the
 * #119 fail-closed boundary. There is a single canonical list (imported, never
 * re-declared here), so the route cannot register anything outside
 * `selectRegisteredFunctions(inngestFunctions)`.
 *
 * Run: npx tsx --test src/lib/inngest/route-registration.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { inngestFunctions, registeredFunctions } from './functions'
import { selectRegisteredFunctions } from './registration'

const ids = inngestFunctions.map((f) => (f as { opts: { id: string } }).opts.id)

// The functions that existed before the event-driven refresh was added.
const EXISTING_FUNCTION_IDS = [
  'pre-meeting-scan',
  'pre-meeting-dispatch',
  'delivery-dropbox-scan',
  'delivery-specs-scan',
  'delivery-job-notifier',
  'delivery-stale-sweep',
  'studio-knowledge-auto-summarize',
  'brain-deadline-sweep',
  'brain-scavenger-scan',
  'brain-consolidate',
  'drive-transcript-scan',
  'plaud-transcript-scan',
  'health-watchdog',
  'project-control-sync',
]

describe('canonical Inngest registration list', () => {
  it('contains every existing canonical function (none dropped)', () => {
    for (const id of EXISTING_FUNCTION_IDS) {
      assert.ok(ids.includes(id), `canonical list is missing ${id}`)
    }
  })

  it('contains both project-control-sync and project-control-sync-on-edit', () => {
    assert.ok(ids.includes('project-control-sync'), 'cron missing')
    assert.ok(ids.includes('project-control-sync-on-edit'), 'event fn missing')
  })

  it('registers the private archive publisher workflow', () => {
    assert.ok(ids.includes('archive-publisher'), 'archive publisher missing')
    assert.ok(ids.includes('archive-recovery'), 'archive recovery missing')
  })

  it('registers project-control-sync immediately before project-control-sync-on-edit (adjacent + ordered)', () => {
    const cronIdx = ids.indexOf('project-control-sync')
    assert.notEqual(cronIdx, -1, 'cron not found')
    assert.equal(ids[cronIdx + 1], 'project-control-sync-on-edit', 'event fn must directly follow the cron')
  })
})

describe('environment boundary applied to the REAL canonical list', () => {
  it('production registers the full canonical list', () => {
    assert.deepEqual(selectRegisteredFunctions(inngestFunctions, { VERCEL_ENV: 'production' }), inngestFunctions)
  })

  it('local / non-Vercel (VERCEL_ENV unset) registers the full canonical list', () => {
    assert.deepEqual(selectRegisteredFunctions(inngestFunctions, {}), inngestFunctions)
  })

  it('preview registers ZERO functions by default', () => {
    assert.deepEqual(selectRegisteredFunctions(inngestFunctions, { VERCEL_ENV: 'preview' }), [])
  })

  it('preview WITH exact KIT_INNGEST_ALLOW_PREVIEW=true registers the full canonical list', () => {
    assert.deepEqual(
      selectRegisteredFunctions(inngestFunctions, { VERCEL_ENV: 'preview', KIT_INNGEST_ALLOW_PREVIEW: 'true' }),
      inngestFunctions,
    )
  })
})

describe('route wiring', () => {
  it('serve() registers exactly selectRegisteredFunctions(inngestFunctions) — nothing outside the guard', () => {
    // `registeredFunctions` is the exact value passed to serve(); it must be the
    // canonical list run through the boundary (same env the module evaluated in).
    assert.deepEqual(registeredFunctions, selectRegisteredFunctions(inngestFunctions, process.env))
  })
})
