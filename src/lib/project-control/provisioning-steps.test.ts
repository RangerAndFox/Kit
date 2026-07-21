/**
 * Durable per-service provisioning tests — through the REAL runDurableProvisioning
 * with an injected in-memory step ledger (no DB).
 *
 * Run: npx tsx --test src/lib/project-control/provisioning-steps.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runDurableProvisioning,
  type StepLedger,
  type PersistedStep,
  type StepResult,
} from './provisioning-steps'

/** In-memory ledger honoring getSteps + upsert-by-(project,service). */
function fakeLedger(seed: PersistedStep[] = [], renew?: () => Promise<boolean>): StepLedger & {
  steps: Map<string, PersistedStep>
  runningMarks: string[]
} {
  const steps = new Map<string, PersistedStep>()
  for (const s of seed) steps.set(s.service, { ...s })
  const runningMarks: string[] = []
  return {
    steps,
    runningMarks,
    async getSteps() {
      return [...steps.values()]
    },
    async markStep(_p, service, patch) {
      if (patch.status === 'running') runningMarks.push(service)
      const prev = steps.get(service) || { service, status: 'pending', result: null }
      steps.set(service, {
        service,
        status: (patch.status as PersistedStep['status']) ?? prev.status,
        result: patch.result !== undefined ? patch.result : prev.result,
      })
    },
    renew,
  }
}

const ok = (service: string, extra: Record<string, unknown> = {}): StepResult => ({ service, success: true, ...extra })

describe('runDurableProvisioning', () => {
  it('runs every service on a fresh run and records each as done', async () => {
    const ledger = fakeLedger()
    const calls: string[] = []
    const res = await runDurableProvisioning(
      {
        projectId: 'p1',
        phases: [
          () => [
            { service: 'dropbox', run: async () => { calls.push('dropbox'); return ok('dropbox', { url: 'db' }) } },
            { service: 'frameio', run: async () => { calls.push('frameio'); return ok('frameio', { url: 'f' }) } },
          ],
        ],
      },
      ledger,
    )
    assert.deepEqual(calls.sort(), ['dropbox', 'frameio'])
    assert.deepEqual(res.ran.sort(), ['dropbox', 'frameio'])
    assert.deepEqual(res.resumed, [])
    assert.equal(res.results.dropbox.url, 'db')
    assert.equal(ledger.steps.get('dropbox')?.status, 'done')
    assert.equal(ledger.steps.get('frameio')?.status, 'done')
  })

  it('skips already-done services on resume and reuses their stored result', async () => {
    const ledger = fakeLedger([
      { service: 'dropbox', status: 'done', result: { service: 'dropbox', success: true, url: 'db-cached' } },
    ])
    const calls: string[] = []
    const res = await runDurableProvisioning(
      {
        projectId: 'p1',
        phases: [
          () => [
            { service: 'dropbox', run: async () => { calls.push('dropbox'); return ok('dropbox', { url: 'db-new' }) } },
            { service: 'frameio', run: async () => { calls.push('frameio'); return ok('frameio') } },
          ],
        ],
      },
      ledger,
    )
    // Dropbox was done → not re-run; frameio runs.
    assert.deepEqual(calls, ['frameio'])
    assert.deepEqual(res.resumed, ['dropbox'])
    assert.deepEqual(res.ran, ['frameio'])
    // Reused the cached result, not the fresh one.
    assert.equal(res.results.dropbox.url, 'db-cached')
  })

  it('a soft failure (success:false) is recorded failed and re-runs on the next pass', async () => {
    const ledger = fakeLedger()
    let attempts = 0
    const plan = {
      projectId: 'p1',
      phases: [
        () => [{ service: 'harvest', run: async () => { attempts++; return attempts === 1 ? { service: 'harvest', success: false, error: 'rate limited' } : ok('harvest') } }],
      ],
    }
    const first = await runDurableProvisioning(plan, ledger)
    assert.equal(first.results.harvest.success, false)
    assert.equal(ledger.steps.get('harvest')?.status, 'failed')
    // Resume: failed step is not in the done set, so it retries and converges.
    const second = await runDurableProvisioning(plan, ledger)
    assert.equal(second.results.harvest.success, true)
    assert.deepEqual(second.ran, ['harvest'])
    assert.equal(ledger.steps.get('harvest')?.status, 'done')
    assert.equal(attempts, 2)
  })

  it('a thrown error is captured as a failed step, not propagated', async () => {
    const ledger = fakeLedger()
    const res = await runDurableProvisioning(
      { projectId: 'p1', phases: [() => [{ service: 'slack', run: async () => { throw new Error('boom') } }]] },
      ledger,
    )
    assert.equal(res.results.slack.success, false)
    assert.equal(res.results.slack.error, 'boom')
    assert.equal(ledger.steps.get('slack')?.status, 'failed')
  })

  it('a later phase sees earlier results — including resumed ones', async () => {
    const ledger = fakeLedger([
      { service: 'dropbox', status: 'done', result: { service: 'dropbox', success: true, url: 'DB' } },
    ])
    let slackSawUrl: string | undefined
    await runDurableProvisioning(
      {
        projectId: 'p1',
        phases: [
          () => [{ service: 'frameio', run: async () => ok('frameio', { url: 'FIO' }) }],
          (acc) => [{ service: 'slack', run: async () => { slackSawUrl = `${acc.dropbox?.url}+${acc.frameio?.url}`; return ok('slack') } }],
        ],
      },
      ledger,
    )
    // Slack (phase 2) saw the resumed dropbox url AND the phase-1 frameio url.
    assert.equal(slackSawUrl, 'DB+FIO')
  })

  it('stops before the next phase when the lease heartbeat fails (cooperative fencing)', async () => {
    const ledger = fakeLedger([], async () => false) // renew always fails
    const ran: string[] = []
    const res = await runDurableProvisioning(
      {
        projectId: 'p1',
        phases: [
          () => [{ service: 'dropbox', run: async () => { ran.push('dropbox'); return ok('dropbox') } }],
          () => [{ service: 'slack', run: async () => { ran.push('slack'); return ok('slack') } }],
        ],
      },
      ledger,
    )
    assert.equal(res.abortedLostLease, true)
    // Phase 1 ran; phase 2 did NOT (lease lost at the boundary).
    assert.deepEqual(ran, ['dropbox'])
  })
})
