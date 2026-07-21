/**
 * Railway recovery-sweep tests — through the REAL runProjectControlRecovery with
 * injected fakes (no DB, no Slack).
 *
 * Run: npx tsx --test src/lib/project-control/recovery.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runProjectControlRecovery,
  isResumable,
  type RecoveryDeps,
  type RecoverableRequest,
  type IncompleteBinding,
} from './recovery'

function req(over: Partial<RecoverableRequest> = {}): RecoverableRequest {
  return {
    request_key: 'V1',
    status: 'provisioning',
    decision: null,
    project_id: 'proj',
    submission: {},
    workspace_id: 'ws',
    requested_by_slack_user_id: 'U',
    ...over,
  }
}

function makeDeps(over: Partial<RecoveryDeps> = {}): RecoveryDeps & {
  resumed: string[]
  rebound: string[]
} {
  const resumed: string[] = []
  const rebound: string[] = []
  return {
    resumed,
    rebound,
    listRecoverableRequests: async () => [],
    claimRequest: async () => ({ ok: true, fence: 1 }),
    resumeRequest: async (r, _holder) => { resumed.push(r.request_key) },
    listIncompleteBindings: async () => [],
    rebind: async (b) => { rebound.push(b.project_id) },
    makeHolder: (rk) => `recovery:${rk}:uuid`,
    ...over,
  }
}

describe('isResumable', () => {
  it('resumes crashed nonterminal states', () => {
    assert.equal(isResumable({ status: 'pending', decision: null }), true)
    assert.equal(isResumable({ status: 'provisioning', decision: null }), true)
    assert.equal(isResumable({ status: 'error', decision: null }), true)
  })
  it('resumes awaiting_decision ONLY once the user has decided', () => {
    assert.equal(isResumable({ status: 'awaiting_decision', decision: null }), false)
    assert.equal(isResumable({ status: 'awaiting_decision', decision: 'replace' }), true)
  })
  it('never resumes terminal states', () => {
    assert.equal(isResumable({ status: 'completed', decision: null }), false)
    assert.equal(isResumable({ status: 'cancelled', decision: null }), false)
  })
  it('resumes an INCONSISTENT completed request that still owns incomplete steps', () => {
    assert.equal(isResumable({ status: 'completed', decision: null, hasIncompleteSteps: true }), true)
    // cancelled is ALWAYS terminal, even with stray steps.
    assert.equal(isResumable({ status: 'cancelled', decision: null, hasIncompleteSteps: true }), false)
  })
})

describe('runProjectControlRecovery', () => {
  it('resumes a crashed provisioning request', async () => {
    const deps = makeDeps({ listRecoverableRequests: async () => [req({ status: 'provisioning' })] })
    const s = await runProjectControlRecovery(deps)
    assert.deepEqual(deps.resumed, ['V1'])
    assert.equal(s.requestsResumed, 1)
  })

  it('passes the SAME holder to claim and resume (heartbeat renews the reclaimed lease)', async () => {
    const claimHolders: string[] = []
    const resumeHolders: string[] = []
    const deps = makeDeps({
      listRecoverableRequests: async () => [req()],
      makeHolder: (rk) => `recovery:${rk}:fixeduuid`,
      claimRequest: async (_rk, holder) => { claimHolders.push(holder); return { ok: true, fence: 1 } },
      resumeRequest: async (_r, holder) => { resumeHolders.push(holder) },
    })
    await runProjectControlRecovery(deps)
    assert.deepEqual(claimHolders, ['recovery:V1:fixeduuid'])
    assert.deepEqual(resumeHolders, ['recovery:V1:fixeduuid'])
  })

  it('leaves an awaiting_decision request with no decision untouched', async () => {
    const deps = makeDeps({
      listRecoverableRequests: async () => [req({ status: 'awaiting_decision', decision: null })],
    })
    const s = await runProjectControlRecovery(deps)
    assert.deepEqual(deps.resumed, [])
    assert.equal(s.requestsSkippedAwaitingUser, 1)
  })

  it('resumes an awaiting_decision request that already carries a decision (restart-safe replace)', async () => {
    const deps = makeDeps({
      listRecoverableRequests: async () => [req({ status: 'awaiting_decision', decision: 'replace' })],
    })
    const s = await runProjectControlRecovery(deps)
    assert.deepEqual(deps.resumed, ['V1'])
    assert.equal(s.requestsResumed, 1)
  })

  it('skips a request whose lease is still actively held (claim fails)', async () => {
    const deps = makeDeps({
      listRecoverableRequests: async () => [req()],
      claimRequest: async () => ({ ok: false, fence: null }),
    })
    const s = await runProjectControlRecovery(deps)
    assert.deepEqual(deps.resumed, [])
    assert.equal(s.requestsSkippedLeased, 1)
  })

  it('a resume failure is counted, not thrown, and does not stop the sweep', async () => {
    const deps = makeDeps({
      listRecoverableRequests: async () => [req({ request_key: 'A' }), req({ request_key: 'B' })],
      resumeRequest: async (r) => { if (r.request_key === 'A') throw new Error('nope') },
    })
    const s = await runProjectControlRecovery(deps)
    assert.equal(s.requestsFailed, 1)
    assert.equal(s.requestsResumed, 1) // B still resumed
  })

  it('merges step-based discovery, deduped by request_key, and resumes inconsistent-completed', async () => {
    const deps = makeDeps({
      listRecoverableRequests: async () => [req({ request_key: 'V1', status: 'provisioning' })],
      listStepRecoverableRequests: async () => [
        req({ request_key: 'V1', status: 'provisioning', hasIncompleteSteps: true }), // dup of V1 → deduped
        req({ request_key: 'V2', status: 'completed', hasIncompleteSteps: true }), // inconsistent → resumed
      ],
    })
    const s = await runProjectControlRecovery(deps)
    assert.deepEqual(deps.resumed.sort(), ['V1', 'V2'])
    assert.equal(s.requestsResumed, 2) // V1 counted once (deduped)
  })

  it('re-drives every incomplete binding', async () => {
    const bindings: IncompleteBinding[] = [
      { project_id: 'p1', creation_state: 'sheet_bound' },
      { project_id: 'p2', creation_state: 'pending_canvas' },
    ]
    const deps = makeDeps({ listIncompleteBindings: async () => bindings })
    const s = await runProjectControlRecovery(deps)
    assert.deepEqual(deps.rebound.sort(), ['p1', 'p2'])
    assert.equal(s.bindingsRebound, 2)
  })

  it('a rebind failure is counted, not thrown', async () => {
    const deps = makeDeps({
      listIncompleteBindings: async () => [
        { project_id: 'p1', creation_state: 'sheet_bound' },
        { project_id: 'p2', creation_state: 'pending_canvas' },
      ],
      rebind: async (b) => { if (b.project_id === 'p1') throw new Error('boom') },
    })
    const s = await runProjectControlRecovery(deps)
    assert.equal(s.bindingsFailed, 1)
    assert.equal(s.bindingsRebound, 1)
  })
})
