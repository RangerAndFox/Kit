/**
 * Durable per-service provisioning tests — through the REAL runDurableProvisioning
 * with an injected in-memory step ledger modeling per-step ownership (claim /
 * fence / holder-conditional complete). No DB.
 *
 * Run: npx tsx --test src/lib/project-control/provisioning-steps.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runDurableProvisioning, type StepLedger, type StepResult } from './provisioning-steps'

interface Row {
  service: string
  status: string
  result: Record<string, unknown> | null
  fence: number
  holder: string | null
  external_id?: string | null
}

/**
 * In-memory ledger with a single logical holder (the run) unless `otherHolder`
 * pre-claims a row to simulate a competing/stale worker.
 */
function fakeLedger(seed: Partial<Row>[] = [], renew?: () => Promise<boolean>) {
  const rows = new Map<string, Row>()
  for (const s of seed) rows.set(s.service!, { service: s.service!, status: s.status ?? 'pending', result: s.result ?? null, fence: s.fence ?? 0, holder: s.holder ?? null, external_id: s.external_id ?? null })
  const HOLDER = 'run-A'

  const ledger: StepLedger & { rows: Map<string, Row>; getEarly?: number } = {
    rows,
    async getSteps() {
      return [...rows.values()].map((r) => ({ service: r.service, status: r.status, result: r.result }))
    },
    async claimStep(_pid, service) {
      const cur = rows.get(service) || { service, status: 'pending', result: null, fence: 0, holder: null }
      rows.set(service, cur)
      if (cur.status === 'done' || cur.status === 'terminal') return { ok: false, fence: cur.fence, status: cur.status }
      if (cur.holder && cur.holder !== HOLDER) return { ok: false, fence: cur.fence, status: cur.status } // actively leased by another
      cur.fence += 1
      cur.holder = HOLDER
      cur.status = 'running'
      return { ok: true, fence: cur.fence, status: 'running' }
    },
    async recordExternalId(_pid, service, fence, o) {
      const cur = rows.get(service)
      if (!cur || cur.holder !== HOLDER || cur.fence !== fence) return false
      if (o.externalId !== undefined) cur.external_id = o.externalId
      return true
    },
    async completeStep(_pid, service, fence, patch) {
      const cur = rows.get(service)
      if (!cur || cur.holder !== HOLDER || cur.fence !== fence) return false // lost ownership
      cur.status = patch.status
      cur.result = patch.result ?? cur.result
      cur.holder = null
      return true
    },
    renew,
  }
  return ledger
}

const ok = (service: string, extra: Record<string, unknown> = {}): StepResult => ({ service, success: true, ...extra })

describe('runDurableProvisioning (per-step ownership)', () => {
  it('runs every service on a fresh run; allRequiredDone when all done', async () => {
    const ledger = fakeLedger()
    const calls: string[] = []
    const res = await runDurableProvisioning(
      {
        projectId: 'p1',
        requiredServices: ['dropbox', 'frameio'],
        phases: [() => [
          { service: 'dropbox', run: async () => { calls.push('dropbox'); return ok('dropbox', { url: 'db' }) } },
          { service: 'frameio', run: async () => { calls.push('frameio'); return ok('frameio') } },
        ]],
      },
      ledger,
    )
    assert.deepEqual(calls.sort(), ['dropbox', 'frameio'])
    assert.equal(res.allRequiredDone, true)
    assert.equal(res.anyTerminal, false)
    assert.deepEqual(res.incompleteServices, [])
  })

  it('skips already-done services and reuses their stored result', async () => {
    const ledger = fakeLedger([{ service: 'dropbox', status: 'done', result: { service: 'dropbox', success: true, url: 'db-cached' } }])
    const calls: string[] = []
    const res = await runDurableProvisioning(
      {
        projectId: 'p1',
        requiredServices: ['dropbox', 'frameio'],
        phases: [() => [
          { service: 'dropbox', run: async () => { calls.push('dropbox'); return ok('dropbox', { url: 'db-new' }) } },
          { service: 'frameio', run: async () => { calls.push('frameio'); return ok('frameio') } },
        ]],
      },
      ledger,
    )
    assert.deepEqual(calls, ['frameio'])
    assert.deepEqual(res.resumed, ['dropbox'])
    assert.equal(res.results.dropbox.url, 'db-cached')
    assert.equal(res.allRequiredDone, true)
  })

  it('a failed step keeps allRequiredDone false and lists it incomplete (retryable)', async () => {
    const ledger = fakeLedger()
    const res = await runDurableProvisioning(
      {
        projectId: 'p1',
        requiredServices: ['harvest'],
        phases: [() => [{ service: 'harvest', run: async () => ({ service: 'harvest', success: false, error: 'rate limited' }) }]],
      },
      ledger,
    )
    assert.equal(res.allRequiredDone, false)
    assert.equal(res.anyTerminal, false)
    assert.deepEqual(res.incompleteServices, ['harvest'])
    assert.equal(ledger.rows.get('harvest')?.status, 'failed')
  })

  it('a terminal failure sets anyTerminal and blocks completion', async () => {
    const ledger = fakeLedger()
    const res = await runDurableProvisioning(
      {
        projectId: 'p1',
        requiredServices: ['harvest'],
        phases: [() => [{ service: 'harvest', run: async () => ({ service: 'harvest', success: false, terminal: true, error: 'bad config' }) }]],
      },
      ledger,
    )
    assert.equal(res.allRequiredDone, false)
    assert.equal(res.anyTerminal, true)
    assert.equal(ledger.rows.get('harvest')?.status, 'terminal')
  })

  it('a failed step retries and converges on the next pass', async () => {
    const ledger = fakeLedger()
    let attempts = 0
    const plan = {
      projectId: 'p1',
      requiredServices: ['harvest'],
      phases: [() => [{ service: 'harvest', run: async () => { attempts++; return attempts === 1 ? { service: 'harvest', success: false, error: 'x' } : ok('harvest') } }]],
    }
    const first = await runDurableProvisioning(plan, ledger)
    assert.equal(first.allRequiredDone, false)
    const second = await runDurableProvisioning(plan, ledger)
    assert.equal(second.allRequiredDone, true)
    assert.equal(attempts, 2)
  })

  it('rejects a stale worker: completeStep fails when the fence advanced mid-run', async () => {
    const ledger = fakeLedger()
    // While "our" run holds the harvest step, a competitor reclaims it (bumps
    // fence + steals holder) before we complete → our complete is rejected.
    const res = await runDurableProvisioning(
      {
        projectId: 'p1',
        requiredServices: ['harvest'],
        phases: [() => [{ service: 'harvest', run: async () => {
          const row = ledger.rows.get('harvest')!
          row.fence += 1 // competitor reclaim
          row.holder = 'run-B'
          return ok('harvest')
        } }]],
      },
      ledger,
    )
    assert.deepEqual(res.lostOwnership, ['harvest'])
    assert.equal(res.ran.includes('harvest'), false)
  })

  it('skips a step already claimed (in-flight) by another worker', async () => {
    const ledger = fakeLedger([{ service: 'slack', status: 'running', holder: 'run-B', fence: 3 }])
    const res = await runDurableProvisioning(
      {
        projectId: 'p1',
        requiredServices: ['slack'],
        phases: [() => [{ service: 'slack', run: async () => ok('slack') }]],
      },
      ledger,
    )
    assert.deepEqual(res.skippedInFlight, ['slack'])
    assert.equal(res.allRequiredDone, false)
  })

  it('a later phase sees earlier results — including resumed ones', async () => {
    const ledger = fakeLedger([{ service: 'dropbox', status: 'done', result: { service: 'dropbox', success: true, url: 'DB' } }])
    let seen: string | undefined
    await runDurableProvisioning(
      {
        projectId: 'p1',
        requiredServices: ['dropbox', 'frameio', 'slack'],
        phases: [
          () => [{ service: 'frameio', run: async () => ok('frameio', { url: 'FIO' }) }],
          (acc) => [{ service: 'slack', run: async () => { seen = `${acc.dropbox?.url}+${acc.frameio?.url}`; return ok('slack') } }],
        ],
      },
      ledger,
    )
    assert.equal(seen, 'DB+FIO')
  })

  it('aborts before a phase when the request lease is lost', async () => {
    let n = 0
    const ledger = fakeLedger([], async () => { n++; return n === 1 })
    const ran: string[] = []
    const res = await runDurableProvisioning(
      {
        projectId: 'p1',
        requiredServices: ['dropbox', 'slack'],
        phases: [
          () => [{ service: 'dropbox', run: async () => { ran.push('dropbox'); return ok('dropbox') } }],
          () => [{ service: 'slack', run: async () => { ran.push('slack'); return ok('slack') } }],
        ],
      },
      ledger,
    )
    assert.equal(res.abortedLostLease, true)
    assert.deepEqual(ran, ['dropbox'])
  })

  it('a failed replace_cleanup step blocks completion (never silently completed)', async () => {
    const ledger = fakeLedger()
    const res = await runDurableProvisioning(
      {
        projectId: 'p1',
        requiredServices: ['replace_cleanup', 'dropbox'],
        phases: [
          () => [{ service: 'replace_cleanup', run: async () => { throw new Error('delete failed') } }],
          () => [{ service: 'dropbox', run: async () => ok('dropbox') }],
        ],
      },
      ledger,
    )
    assert.equal(res.allRequiredDone, false)
    assert.ok(res.incompleteServices.includes('replace_cleanup'))
    assert.equal(ledger.rows.get('replace_cleanup')?.status, 'failed') // retryable
  })

  it('propagates a getSteps store error (never treats it as an empty ledger)', async () => {
    const ledger = fakeLedger()
    ledger.getSteps = async () => { throw new Error('db down') }
    await assert.rejects(
      runDurableProvisioning({ projectId: 'p1', requiredServices: ['dropbox'], phases: [() => [{ service: 'dropbox', run: async () => ok('dropbox') }]] }, ledger),
      /db down/,
    )
  })
})
