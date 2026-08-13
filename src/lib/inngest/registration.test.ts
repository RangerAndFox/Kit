/**
 * Inngest registration environment-boundary tests.
 *
 * Proves the fail-closed matrix: production and local development register the
 * full function set; a Vercel Preview deployment registers ZERO functions
 * unless it explicitly opts in with KIT_INNGEST_ALLOW_PREVIEW=true.
 *
 * Pure (env is injected), so no process.env mutation and no module-cache tricks.
 *
 * Run: npx tsx --test src/lib/inngest/registration.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectRegisteredFunctions, isPreviewRegistrationBlocked } from './registration'

/** Stand-in for the real function list — the selector is agnostic to contents. */
const ALL = ['preMeetingScan', 'deliverySpecsScan', 'healthWatchdog', 'projectControlSync']

describe('selectRegisteredFunctions — environment boundary', () => {
  it('production registers ALL functions', () => {
    const env = { VERCEL_ENV: 'production' }
    assert.deepEqual(selectRegisteredFunctions(ALL, env), ALL)
    assert.equal(isPreviewRegistrationBlocked(env), false)
  })

  it('local / non-Vercel development (VERCEL_ENV unset) registers ALL functions', () => {
    const env = {}
    assert.deepEqual(selectRegisteredFunctions(ALL, env), ALL)
    assert.equal(isPreviewRegistrationBlocked(env), false)
  })

  it('preview registers ZERO functions by default', () => {
    const env = { VERCEL_ENV: 'preview' }
    assert.deepEqual(selectRegisteredFunctions(ALL, env), [])
    assert.equal(isPreviewRegistrationBlocked(env), true)
  })

  it('preview WITH explicit opt-in registers ALL functions', () => {
    const env = { VERCEL_ENV: 'preview', KIT_INNGEST_ALLOW_PREVIEW: 'true' }
    assert.deepEqual(selectRegisteredFunctions(ALL, env), ALL)
    assert.equal(isPreviewRegistrationBlocked(env), false)
  })

  it('fails closed on any non-exact opt-in value', () => {
    for (const value of ['false', 'TRUE', '1', 'yes', '']) {
      const env = { VERCEL_ENV: 'preview', KIT_INNGEST_ALLOW_PREVIEW: value }
      assert.deepEqual(selectRegisteredFunctions(ALL, env), [], `opt-in value ${JSON.stringify(value)} must not unblock`)
    }
  })

  it('NODE_ENV is not the boundary — a preview build with NODE_ENV=production still registers zero', () => {
    // Preview builds run with NODE_ENV=production, which is exactly why the
    // boundary keys off VERCEL_ENV instead.
    const env = { VERCEL_ENV: 'preview', NODE_ENV: 'production' }
    assert.deepEqual(selectRegisteredFunctions(ALL, env), [])
  })

  it('the opt-in does not widen production or local (no accidental behavior change)', () => {
    const prod = { VERCEL_ENV: 'production', KIT_INNGEST_ALLOW_PREVIEW: 'true' }
    const local = { KIT_INNGEST_ALLOW_PREVIEW: 'true' }
    assert.deepEqual(selectRegisteredFunctions(ALL, prod), ALL)
    assert.deepEqual(selectRegisteredFunctions(ALL, local), ALL)
  })

  it('does not mutate or reorder the provided list', () => {
    const input = [...ALL]
    const out = selectRegisteredFunctions(input, { VERCEL_ENV: 'production' })
    assert.deepEqual(input, ALL) // untouched
    assert.deepEqual(out, ALL) // same order — function IDs/schedules unchanged
  })
})
