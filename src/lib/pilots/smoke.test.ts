/**
 * The local smoke harness runs green (CI guard for the operator command path).
 * Run: npx tsx --test src/lib/pilots/smoke.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runSmoke } from './smoke'

describe('pilot smoke harness', () => {
  it('completes the full fake-backed command path', async () => {
    const report = await runSmoke()
    const failed = report.steps.filter((s) => !s.ok)
    assert.equal(report.passed, true, `failed steps: ${failed.map((s) => `${s.name}(${s.detail})`).join('; ')}`)
    assert.ok(report.pilotId)
  })
})
