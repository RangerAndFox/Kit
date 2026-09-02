/**
 * runProjectUpdate: phased, durable, idempotent ripple through the REAL
 * runDurableProvisioning engine with an injected in-memory ledger + fake deps.
 *
 * Run: npx tsx --test src/lib/provisioner/update.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runProjectUpdate, type UpdateDeps, type UpdateStepRunResult } from './update'
import { computeUpdatePlan, type ProjectSnapshot, type UpdateForm } from './update-diff'
import type { StepLedger } from '../project-control/provisioning-steps'

interface Row { service: string; status: string; result: Record<string, unknown> | null; fence: number; holder: string | null }

function fakeLedger(seed: Partial<Row>[] = [], renew?: () => Promise<boolean>) {
  const rows = new Map<string, Row>()
  for (const s of seed) rows.set(s.service!, { service: s.service!, status: s.status ?? 'pending', result: s.result ?? null, fence: s.fence ?? 0, holder: s.holder ?? null })
  const HOLDER = 'run-A'
  const ledger: StepLedger & { rows: Map<string, Row> } = {
    rows,
    async getSteps() { return [...rows.values()].map((r) => ({ service: r.service, status: r.status, result: r.result })) },
    async claimStep(_pid, service) {
      const cur = rows.get(service) || { service, status: 'pending', result: null, fence: 0, holder: null }
      rows.set(service, cur)
      if (cur.status === 'done' || cur.status === 'terminal') return { ok: false, fence: cur.fence, status: cur.status }
      if (cur.holder && cur.holder !== HOLDER) return { ok: false, fence: cur.fence, status: cur.status }
      cur.fence += 1; cur.holder = HOLDER; cur.status = 'running'
      return { ok: true, fence: cur.fence, status: 'running' }
    },
    async completeStep(_pid, service, fence, patch) {
      const cur = rows.get(service)
      if (!cur || cur.holder !== HOLDER || cur.fence !== fence) return false
      cur.status = patch.status; cur.result = patch.result ?? cur.result; cur.holder = null
      return true
    },
    renew,
  }
  return ledger
}

const SNAP: ProjectSnapshot = {
  projectId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  projectNumber: '2601', clientName: 'Nike', clientContact: 'Jane', projectName: 'Summer Campaign',
  projectType: 'Brand Video', projectManagerSlackId: 'U1', creativeDirectorSlackId: 'U2',
  startDate: '2026-01-01', targetDelivery: '2026-03-01', briefSummary: 'brief',
}
function form(overrides: Partial<UpdateForm> = {}): UpdateForm {
  return { projectNumber: '2601', clientName: 'Nike', clientContact: 'Jane', projectName: 'Summer Campaign', projectType: 'Brand Video', projectManager: 'U1', creativeDirector: 'U2', startDate: '2026-01-01', deadline: '2026-03-01', description: 'brief', ...overrides }
}

/** A deps double that records every dispatch + persist call. */
function fakeDeps(overrides: Partial<UpdateDeps> = {}) {
  const calls: string[] = []
  const dropboxWrites: Array<{ safeName: string; path: string }> = []
  const deps: UpdateDeps = {
    dispatch: async (service, _action, payload): Promise<UpdateStepRunResult> => {
      calls.push(`dispatch:${service}`)
      if (service === 'dropbox') {
        return { success: true, id: '/production/2026/2601_Adidas_Summer_Campaign', url: 'db', data: { newSafeName: '2601_Adidas_Summer_Campaign', path: '/production/2026/2601_Adidas_Summer_Campaign' } }
      }
      return { success: true, id: `${service}-id`, url: `${service}-url` }
    },
    persistDropboxMove: async (_pid, o) => { calls.push('persistDropbox'); dropboxWrites.push({ safeName: o.safeName, path: o.path }) },
    updateSheet: async () => { calls.push('sheet'); return { success: true } },
    updateProjectRow: async () => { calls.push('supabase'); return { success: true } },
    refreshProjectControl: async () => { calls.push('project_control'); return { success: true } },
    ledger: fakeLedger(),
    ...overrides,
  }
  return { deps, calls, dropboxWrites }
}

describe('runProjectUpdate — phasing + services', () => {
  it('a description-only change ripples to supabase only', async () => {
    const plan = computeUpdatePlan(SNAP, form({ description: 'new' }))
    const { deps, calls } = fakeDeps()
    const out = await runProjectUpdate({ updateRequestId: 'R', projectId: SNAP.projectId, submission: form({ description: 'new' }), plan, current: {} }, deps)
    assert.deepEqual(calls, ['supabase'])
    assert.equal(out.allRequiredDone, true)
    assert.equal(out.finalStatus, 'active')
  })

  it('a client change ripples to every service and finishes active', async () => {
    const f = form({ clientName: 'Adidas' })
    const plan = computeUpdatePlan(SNAP, f)
    const { deps, calls, dropboxWrites } = fakeDeps()
    const out = await runProjectUpdate({ updateRequestId: 'R', projectId: SNAP.projectId, submission: f, plan, current: { slackChannelId: 'C1', dropboxPath: '/production/2026/2601_Nike_Summer_Campaign' } }, deps)
    // external renames all dispatched
    for (const s of ['slack', 'frameio', 'harvest', 'dropbox']) assert.ok(calls.includes(`dispatch:${s}`), `missing ${s}`)
    // dropbox safe-name persisted, and the supabase step ran AFTER it
    assert.equal(dropboxWrites.length, 1)
    assert.ok(calls.indexOf('persistDropbox') < calls.indexOf('supabase'))
    assert.ok(calls.indexOf('sheet') < calls.indexOf('supabase')) // sheet before supabase
    assert.ok(calls.indexOf('supabase') < calls.indexOf('project_control'))
    assert.equal(out.allRequiredDone, true)
  })

  it('passes the stored Frame.io provider id to the rename agent', async () => {
    const f = form({ projectName: 'Winter Campaign' })
    const plan = computeUpdatePlan(SNAP, f)
    let seenFrameioProjectId: unknown
    const { deps } = fakeDeps({
      dispatch: async (service, _action, payload) => {
        if (service === 'frameio') seenFrameioProjectId = payload.frameioProjectId
        if (service === 'dropbox') return { success: true, id: '/p/new', data: { newSafeName: 'ns', path: '/p/new' } }
        return { success: true }
      },
    })
    await runProjectUpdate({
      updateRequestId: 'R', projectId: SNAP.projectId, submission: f, plan,
      current: { slackChannelId: 'C1', dropboxPath: '/p/x', frameioProjectId: 'frame-project-1' },
    }, deps)
    assert.equal(seenFrameioProjectId, 'frame-project-1')
  })

  it('a control-center field refreshes the four managed canvases in the final phase', async () => {
    const f = form({ clientContact: 'Janet' })
    const plan = computeUpdatePlan(SNAP, f)
    const { deps, calls } = fakeDeps()
    await runProjectUpdate({ updateRequestId: 'R', projectId: SNAP.projectId, submission: f, plan, current: { slackChannelId: 'C1' } }, deps)
    assert.deepEqual(calls, ['sheet', 'supabase', 'project_control'])
  })

  it('renames use the CURRENT value for an identity field the user did not change', async () => {
    // The user changed only the name; the form still carries the stale open-time
    // client (Nike), but a concurrent edit moved the DB client to Adidas.
    const f = form({ projectName: 'Winter Campaign', clientName: 'Nike' })
    const plan = computeUpdatePlan(SNAP, f) // only project_name is in changes
    let harvestPayload: any = null
    const { deps } = fakeDeps({
      dispatch: async (service, _a, payload): Promise<UpdateStepRunResult> => {
        if (service === 'harvest') harvestPayload = payload
        if (service === 'dropbox') return { success: true, id: '/p/new', data: { newSafeName: 'ns', path: '/p/new' } }
        return { success: true }
      },
    })
    await runProjectUpdate(
      { updateRequestId: 'R', projectId: SNAP.projectId, submission: f, plan,
        current: { slackChannelId: 'C1', dropboxPath: '/p/x', clientName: 'Adidas', projectNumber: '2601', projectName: 'Summer Campaign' } },
      deps,
    )
    // client was NOT in the diff → the rename must use the current 'Adidas', not
    // the stale form 'Nike' (which would revert the concurrent edit).
    assert.equal(harvestPayload.client, 'Adidas')
    assert.equal(harvestPayload.projectName, 'Winter Campaign') // changed field → form value
  })
})

describe('runProjectUpdate — durability', () => {
  it('resumes only incomplete services (a done step is not re-dispatched)', async () => {
    const f = form({ clientName: 'Adidas' })
    const plan = computeUpdatePlan(SNAP, f)
    // harvest already done from a prior attempt.
    const ledger = fakeLedger([{ service: 'harvest', status: 'done', result: { service: 'harvest', success: true } }])
    const { deps, calls } = fakeDeps({ ledger })
    await runProjectUpdate({ updateRequestId: 'R', projectId: SNAP.projectId, submission: f, plan, current: { slackChannelId: 'C1', dropboxPath: '/p/x' } }, deps)
    assert.equal(calls.includes('dispatch:harvest'), false) // reused, not re-run
    assert.ok(calls.includes('dispatch:slack'))
  })

  it('surfaces partial when a required external rename fails', async () => {
    const f = form({ clientName: 'Adidas' })
    const plan = computeUpdatePlan(SNAP, f)
    const { deps } = fakeDeps({
      dispatch: async (service): Promise<UpdateStepRunResult> => {
        if (service === 'frameio') return { success: false, error: 'boom' }
        if (service === 'dropbox') return { success: true, id: '/p/new', data: { newSafeName: 'ns', path: '/p/new' } }
        return { success: true }
      },
    })
    const out = await runProjectUpdate({ updateRequestId: 'R', projectId: SNAP.projectId, submission: f, plan, current: { slackChannelId: 'C1', dropboxPath: '/p/x' } }, deps)
    assert.equal(out.allRequiredDone, false)
    assert.equal(out.finalStatus, 'partial')
    assert.ok(out.incompleteServices.includes('frameio'))
  })

  it('marks anyTerminal when a rename is permanently unresolvable', async () => {
    const f = form({ clientName: 'Adidas' })
    const plan = computeUpdatePlan(SNAP, f)
    const { deps } = fakeDeps({
      dispatch: async (service): Promise<UpdateStepRunResult> => {
        if (service === 'frameio') return { success: false, terminal: true, error: 'ambiguous' }
        if (service === 'dropbox') return { success: true, id: '/p/new', data: { newSafeName: 'ns', path: '/p/new' } }
        return { success: true }
      },
    })
    const out = await runProjectUpdate({ updateRequestId: 'R', projectId: SNAP.projectId, submission: f, plan, current: { slackChannelId: 'C1', dropboxPath: '/p/x' } }, deps)
    assert.equal(out.anyTerminal, true)
    assert.equal(out.finalStatus, 'partial')
    // frameio is the ONLY incomplete service and it's terminal → nothing retryable
    // remains → unrecoverable (caller persists 'needs_attention', not 'error').
    assert.equal(out.unrecoverable, true)
  })

  it('is NOT unrecoverable when a retryable failure sits alongside a terminal one', async () => {
    const f = form({ clientName: 'Adidas' })
    const plan = computeUpdatePlan(SNAP, f)
    const { deps } = fakeDeps({
      dispatch: async (service): Promise<UpdateStepRunResult> => {
        if (service === 'frameio') return { success: false, terminal: true, error: 'ambiguous' }
        if (service === 'harvest') return { success: false, error: 'transient' } // retryable
        if (service === 'dropbox') return { success: true, id: '/p/new', data: { newSafeName: 'ns', path: '/p/new' } }
        return { success: true }
      },
    })
    const out = await runProjectUpdate({ updateRequestId: 'R', projectId: SNAP.projectId, submission: f, plan, current: { slackChannelId: 'C1', dropboxPath: '/p/x' } }, deps)
    assert.equal(out.anyTerminal, true)
    assert.equal(out.unrecoverable, false) // harvest is retryable → recovery should keep going
  })

  it('aborts (no supabase write) when the request lease is lost', async () => {
    const f = form({ clientName: 'Adidas' })
    const plan = computeUpdatePlan(SNAP, f)
    const ledger = fakeLedger([], async () => false) // renew always fails → abort at the first phase barrier
    const { deps, calls } = fakeDeps({ ledger })
    const out = await runProjectUpdate({ updateRequestId: 'R', projectId: SNAP.projectId, submission: f, plan, current: { slackChannelId: 'C1', dropboxPath: '/p/x' } }, deps)
    assert.equal(out.abortedLostLease, true)
    assert.equal(calls.includes('supabase'), false)
  })

  it('a no-op re-run reuses every step (idempotent double-apply)', async () => {
    const f = form({ clientName: 'Adidas' })
    const plan = computeUpdatePlan(SNAP, f)
    const ledger = fakeLedger()
    const first = fakeDeps({ ledger })
    await runProjectUpdate({ updateRequestId: 'R', projectId: SNAP.projectId, submission: f, plan, current: { slackChannelId: 'C1', dropboxPath: '/p/x' } }, first.deps)
    // Second run against the SAME ledger: everything is 'done' → nothing re-dispatched.
    const second = fakeDeps({ ledger })
    const out = await runProjectUpdate({ updateRequestId: 'R', projectId: SNAP.projectId, submission: f, plan, current: { slackChannelId: 'C1', dropboxPath: '/p/x' } }, second.deps)
    assert.deepEqual(second.calls, [])
    assert.equal(out.allRequiredDone, true)
  })
})
