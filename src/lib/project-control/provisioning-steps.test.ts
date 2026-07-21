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

  it('re-runs a crashed (running) step, and a reconcile-first service stays exactly-once', async () => {
    // Stateful "provider": a reconcile-first service creates only when absent.
    const provider = { count: 0 }
    const reconcileFirstRun = async (): Promise<StepResult> => {
      if (provider.count === 0) provider.count++ // create only when absent
      return { service: 'harvest', success: true, id: 'H1' }
    }
    // Simulate a crash mid-create: step was marked 'running' but never 'done',
    // and the external resource DID get created (provider.count = 1).
    provider.count = 1
    const ledger = fakeLedger([{ service: 'harvest', status: 'running', result: null }])

    const res = await runDurableProvisioning(
      { projectId: 'p1', phases: [() => [{ service: 'harvest', run: reconcileFirstRun }]] },
      ledger,
    )
    // The 'running' step re-ran (not in the done set)...
    assert.deepEqual(res.ran, ['harvest'])
    // ...but the reconcile-first service did NOT create a second resource.
    assert.equal(provider.count, 1)
    assert.equal(ledger.steps.get('harvest')?.status, 'done')
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

  it('rejects a phase before its writes once ownership is lost (enforced fence)', async () => {
    // Ownership holds for phase 1, then a newer holder reclaims before phase 2.
    let calls = 0
    const renew = async () => { calls++; return calls === 1 }
    const ledger = fakeLedger([], renew)
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
    // Phase 1 ran (owned); phase 2's write was rejected at the gate BEFORE it ran.
    assert.deepEqual(ran, ['dropbox'])
  })

  it('rejects the very first write when ownership is already lost', async () => {
    const ledger = fakeLedger([], async () => false) // never owned
    const ran: string[] = []
    const res = await runDurableProvisioning(
      { projectId: 'p1', phases: [() => [{ service: 'dropbox', run: async () => { ran.push('dropbox'); return ok('dropbox') } }]] },
      ledger,
    )
    assert.equal(res.abortedLostLease, true)
    assert.deepEqual(ran, []) // nothing dispatched — rejected before the external boundary
  })
})
