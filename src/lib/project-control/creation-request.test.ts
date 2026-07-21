/**
 * Creation-request orchestration tests: authorization + idempotency.
 *
 * Run: npx tsx --test src/lib/project-control/creation-request.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  authorizeResolution,
  ensureProjectForRequest,
  resolveCreationProject,
  runDisabledCreation,
  routeCreationRequest,
  shouldArchiveReplaceTarget,
  resolveReplaceCleanup,
  type RequestStorePort,
} from './creation-request'

// ─── Authorization (pure) ────────────────────────────────────────────────────

describe('authorizeResolution', () => {
  const base = { workspace_id: 'w1', requested_by_slack_user_id: 'U1', status: 'awaiting_decision' }
  const ctx = { actingUserId: 'U1', workspaceId: 'w1', action: 'duplicate' as const }

  it('allows the original requester in the right workspace and state', () => {
    assert.deepEqual(authorizeResolution(base, ctx), { ok: true })
  })
  it('rejects a missing request', () => {
    assert.deepEqual(authorizeResolution(null, ctx), { ok: false, reason: 'not_found' })
  })
  it('rejects a different workspace', () => {
    assert.deepEqual(authorizeResolution(base, { ...ctx, workspaceId: 'w2' }), { ok: false, reason: 'wrong_workspace' })
  })
  it('rejects a non-requester user', () => {
    assert.deepEqual(authorizeResolution(base, { ...ctx, actingUserId: 'U2' }), { ok: false, reason: 'not_authorized' })
  })
  it('rejects an invalid state transition (already provisioning)', () => {
    assert.deepEqual(
      authorizeResolution({ ...base, status: 'provisioning' }, ctx),
      { ok: false, reason: 'invalid_state' },
    )
  })
})

// ─── Idempotent creation ─────────────────────────────────────────────────────

interface FakeRow {
  status: string
  project_id: string | null
  workspace_id: string
  requested_by_slack_user_id: string
  lease_expires_at: number
}

/** In-memory request store with lease semantics (models Supabase). */
class FakeStore implements RequestStorePort {
  rows = new Map<string, FakeRow>()
  async getOrCreateCreationRequest(o: { requestKey: string; workspaceId: string | null; requestedBy: string | null; submission: Record<string, unknown> }) {
    const existing = this.rows.get(o.requestKey)
    if (existing) return { row: existing, created: false }
    const row: FakeRow = {
      status: 'pending', project_id: null,
      workspace_id: o.workspaceId ?? '', requested_by_slack_user_id: o.requestedBy ?? '', lease_expires_at: 0,
    }
    this.rows.set(o.requestKey, row)
    return { row, created: true }
  }
  async loadCreationRequest(k: string) { return this.rows.get(k) ?? null }
  async updateCreationRequest(k: string, patch: Record<string, unknown>) { Object.assign(this.rows.get(k) as FakeRow, patch) }
  async claimCreationRequest(k: string) {
    const r = this.rows.get(k)
    if (!r) return false
    const now = Date.now()
    if (r.lease_expires_at && r.lease_expires_at > now) return false // actively held
    r.lease_expires_at = now + 60_000
    return true
  }
}

function makeDeps(store: RequestStorePort, counter: { n: number }, projects = new Map<string, string>()) {
  return {
    store,
    insertProject: async () => { counter.n++; return { id: `p${counter.n}` } },
    findProjectByRequestId: async (rk: string) => (projects.has(rk) ? { id: projects.get(rk) as string } : null),
    holder: 'h',
  }
}

describe('ensureProjectForRequest', () => {
  it('a redelivered request while in flight creates exactly one project', async () => {
    const store = new FakeStore()
    const counter = { n: 0 }
    const deps = makeDeps(store, counter)
    const args = { requestKey: 'V1', workspaceId: 'w', requestedBy: 'U1', submission: {} }

    const a = await ensureProjectForRequest(deps, args)
    const b = await ensureProjectForRequest(deps, args) // lease still held from (a)

    assert.equal(a.status, 'created')
    assert.equal(a.projectId, 'p1')
    assert.equal(b.status, 'in_flight')
    assert.equal(counter.n, 1) // inserted once
  })

  it('preClaimed (recovery already holds the lease) resumes without re-claiming', async () => {
    const store = new FakeStore()
    const counter = { n: 0 }
    // Recovery holds an ACTIVE lease (future expiry). A normal resume would see
    // the lease as held and return in_flight; preClaimed skips that guard.
    store.rows.set('V-rec', {
      status: 'provisioning', project_id: 'p-rec',
      workspace_id: 'w', requested_by_slack_user_id: 'U1', lease_expires_at: Date.now() + 60_000,
    })
    const deps = { ...makeDeps(store, counter), preClaimed: true }
    const r = await ensureProjectForRequest(deps, { requestKey: 'V-rec', workspaceId: 'w', requestedBy: 'U1', submission: {} })
    assert.equal(r.status, 'resumed')
    assert.equal(r.projectId, 'p-rec')
    assert.equal(counter.n, 0) // no new insert

    // Without preClaimed the same active lease blocks the resume.
    const blocked = await ensureProjectForRequest(makeDeps(store, counter), { requestKey: 'V-rec', workspaceId: 'w', requestedBy: 'U1', submission: {} })
    assert.equal(blocked.status, 'in_flight')
  })

  it('resumes the same project after a simulated restart (expired lease + project_id set)', async () => {
    const store = new FakeStore()
    const counter = { n: 5 }
    const deps = makeDeps(store, counter)
    store.rows.set('V2', {
      status: 'provisioning', project_id: 'p-existing',
      workspace_id: 'w', requested_by_slack_user_id: 'U1', lease_expires_at: Date.now() - 1000,
    })
    const r = await ensureProjectForRequest(deps, { requestKey: 'V2', workspaceId: 'w', requestedBy: 'U1', submission: {} })
    assert.equal(r.status, 'resumed')
    assert.equal(r.projectId, 'p-existing')
    assert.equal(counter.n, 5) // no new insert
  })

  it('does not recreate a completed request', async () => {
    const store = new FakeStore()
    const counter = { n: 0 }
    store.rows.set('V3', { status: 'completed', project_id: 'done', workspace_id: 'w', requested_by_slack_user_id: 'U1', lease_expires_at: 0 })
    const r = await ensureProjectForRequest(makeDeps(store, counter), { requestKey: 'V3', workspaceId: 'w', requestedBy: 'U1', submission: {} })
    assert.equal(r.status, 'already_completed')
    assert.equal(counter.n, 0)
  })

  it('allows an intentional duplicate through a NEW request key', async () => {
    const store = new FakeStore()
    const counter = { n: 0 }
    const deps = makeDeps(store, counter)
    const a = await ensureProjectForRequest(deps, { requestKey: 'V4', workspaceId: 'w', requestedBy: 'U1', submission: {} })
    const b = await ensureProjectForRequest(deps, { requestKey: 'V5', workspaceId: 'w', requestedBy: 'U1', submission: {} })
    assert.equal(a.projectId, 'p1')
    assert.equal(b.projectId, 'p2')
    assert.equal(counter.n, 2) // two distinct projects
  })

  it('reconciles via creation_request_id when the ledger link write never landed (crash window)', async () => {
    const store = new FakeStore()
    const projects = new Map<string, string>()
    let inserts = 0
    // Simulate: project insert succeeds, then the ledger project_id link write
    // FAILS the first time (crash between insert and ledger update).
    const origUpdate = store.updateCreationRequest.bind(store)
    let failLink = true
    store.updateCreationRequest = async (k: string, patch: Record<string, unknown>) => {
      if (failLink && patch.project_id) { failLink = false; throw new Error('ledger link write failed') }
      return origUpdate(k, patch)
    }
    const deps = {
      store,
      insertProject: async () => { inserts++; const id = `p${inserts}`; projects.set('V6', id); return { id } },
      findProjectByRequestId: async (rk: string) => (projects.has(rk) ? { id: projects.get(rk) as string } : null),
      holder: 'h',
    }
    const args = { requestKey: 'V6', workspaceId: 'w', requestedBy: 'U1', submission: {} }

    // 1) insert succeeds, 2) ledger link update throws → the call rejects
    await assert.rejects(ensureProjectForRequest(deps, args))
    // 3) retry after lease expiry
    ;(store.rows.get('V6') as { lease_expires_at: number }).lease_expires_at = Date.now() - 1000
    const r = await ensureProjectForRequest(deps, args)
    // 4) exactly the original project is returned; no second insert
    assert.equal(r.status, 'resumed')
    assert.equal(r.projectId, 'p1')
    assert.equal(inserts, 1)
  })
})

describe('shouldArchiveReplaceTarget (replay-safe replace)', () => {
  it('archives the persisted target for a replace decision', () => {
    assert.deepEqual(
      shouldArchiveReplaceTarget({ decision: 'replace', replace_target_project_id: 'OLD' }, 'NEW'),
      { archive: true, targetId: 'OLD' },
    )
  })
  it('never archives the run\'s own new project (replay cannot delete the replacement)', () => {
    assert.deepEqual(
      shouldArchiveReplaceTarget({ decision: 'replace', replace_target_project_id: 'SAME' }, 'SAME'),
      { archive: false, targetId: null },
    )
  })
  it('does nothing for duplicate/create or a missing target', () => {
    assert.equal(shouldArchiveReplaceTarget({ decision: 'duplicate', replace_target_project_id: 'OLD' }, 'NEW').archive, false)
    assert.equal(shouldArchiveReplaceTarget({ decision: 'create', replace_target_project_id: null }, 'NEW').archive, false)
    assert.equal(shouldArchiveReplaceTarget({ decision: 'replace', replace_target_project_id: null }, 'NEW').archive, false)
  })
})

describe('resolveReplaceCleanup (crash/recovery convergence)', () => {
  it('archives when the target exists and is not the replacement', () => {
    assert.deepEqual(
      resolveReplaceCleanup({ targetId: 'OLD', newProjectId: 'NEW', targetExists: true }),
      { action: 'archive', reason: 'archive' },
    )
  })
  it('no-ops when there is no persisted target', () => {
    assert.deepEqual(
      resolveReplaceCleanup({ targetId: null, newProjectId: 'NEW', targetExists: true }),
      { action: 'noop', reason: 'no_target' },
    )
  })
  it('never archives the run\'s own replacement (replay guard)', () => {
    assert.deepEqual(
      resolveReplaceCleanup({ targetId: 'NEW', newProjectId: 'NEW', targetExists: true }),
      { action: 'noop', reason: 'is_replacement' },
    )
  })
  it('converges to a no-op once the target is already gone (deleted then crashed)', () => {
    assert.deepEqual(
      resolveReplaceCleanup({ targetId: 'OLD', newProjectId: 'NEW', targetExists: false }),
      { action: 'noop', reason: 'already_gone' },
    )
  })
})

// ─── Replace cleanup: durable step stays required until done, across crashes ──
// Models the interactions.ts wiring with the pure decisions, so the three crash
// windows the blocker names are exercised without live Slack/Supabase:
//   (a) crash BEFORE archive, (b) crash AFTER archive (target deleted) but before
//   the step is marked done, (c) resume AFTER deletion → converge.
// The load-bearing precondition is migration 057: the persisted
// replace_target_project_id is IMMUTABLE and survives the target's deletion, so
// every resume still computes the same target and keeps replace_cleanup REQUIRED
// until the step actually reaches done.
describe('replace_cleanup durability (pure simulation of the interactions wiring)', () => {
  const NEW = 'p-new'
  const OLD = 'p-old'

  // A resume pass: (persisted request row, whether the OLD project still exists,
  // whether this pass runs the archive to completion). Returns the derived
  // orchestration state a resume would compute.
  function resumePass(
    req: { decision: string | null; replace_target_project_id: string | null },
    oldExists: boolean,
    completeArchive: boolean,
  ): { requiredIncludesCleanup: boolean; stepReachedDone: boolean; deletedTarget: boolean } {
    const { targetId } = shouldArchiveReplaceTarget(req, NEW)
    const requiredIncludesCleanup = !!targetId
    if (!targetId) return { requiredIncludesCleanup, stepReachedDone: false, deletedTarget: false }

    const decision = resolveReplaceCleanup({ targetId, newProjectId: NEW, targetExists: oldExists })
    if (decision.action === 'noop') {
      // nothing left to archive → the step resolves to success (done)
      return { requiredIncludesCleanup, stepReachedDone: true, deletedTarget: false }
    }
    // action === 'archive': it deletes the target; the step is only 'done' if the
    // pass runs to completion (no crash before completeStep).
    return { requiredIncludesCleanup, stepReachedDone: completeArchive, deletedTarget: true }
  }

  it('(a) crash before archive: cleanup stays required and is retried', () => {
    // Persisted row is untouched (nothing deleted yet).
    const req = { decision: 'replace', replace_target_project_id: OLD }
    const crashed = resumePass(req, /*oldExists*/ true, /*completeArchive*/ false)
    assert.equal(crashed.requiredIncludesCleanup, true)
    assert.equal(crashed.stepReachedDone, false) // not done → request stays incomplete
  })

  it('(b)+(c) crash after archive/deletion, before completion → converges on resume', () => {
    // Pass 1 archives + deletes the target but crashes before marking the step done.
    const req = { decision: 'replace', replace_target_project_id: OLD }
    const pass1 = resumePass(req, /*oldExists*/ true, /*completeArchive*/ false)
    assert.equal(pass1.deletedTarget, true)
    assert.equal(pass1.stepReachedDone, false)

    // Migration 057: the persisted target id SURVIVES the target's deletion, so
    // the request row is unchanged. If it were nulled (pre-057), cleanup would
    // stop being required before it was done — the bug this blocker fixes.
    const reqAfterDelete = { decision: 'replace', replace_target_project_id: OLD }

    // Pass 2 resumes: the target row is now gone → converges to done, and cleanup
    // remained required right up until it reached done.
    const pass2 = resumePass(reqAfterDelete, /*oldExists*/ false, /*completeArchive*/ true)
    assert.equal(pass2.requiredIncludesCleanup, true) // still required this pass
    assert.equal(pass2.stepReachedDone, true) // converged
  })

  it('replay after full completion never targets the replacement', () => {
    // Even a stray extra resume with the same persisted target can only ever
    // no-op (target gone) — and could never resolve to the new project.
    const req = { decision: 'replace', replace_target_project_id: OLD }
    const replay = resumePass(req, /*oldExists*/ false, /*completeArchive*/ true)
    assert.equal(replay.deletedTarget, false) // no delete — nothing to archive
    assert.equal(replay.stepReachedDone, true)
    // And the replay guard rejects the replacement outright:
    assert.equal(
      resolveReplaceCleanup({ targetId: NEW, newProjectId: NEW, targetExists: true }).action,
      'noop',
    )
  })
})

describe('routeCreationRequest (enabled-path state machine)', () => {
  it('1. provisioning + expired lease + linked project → resume', () => {
    assert.deepEqual(
      routeCreationRequest({ status: 'provisioning', linkedProjectId: 'p1', leaseActive: false, unrelatedExisting: null }),
      { action: 'resume', projectId: 'p1' },
    )
  })
  it('2. provisioning + active lease → in_flight', () => {
    assert.deepEqual(
      routeCreationRequest({ status: 'provisioning', linkedProjectId: 'p1', leaseActive: true, unrelatedExisting: null }),
      { action: 'in_flight' },
    )
    // also when claimed but no project yet
    assert.deepEqual(
      routeCreationRequest({ status: 'pending', linkedProjectId: null, leaseActive: true, unrelatedExisting: null }),
      { action: 'in_flight' },
    )
  })
  it('3. pending + project found by creation_request_id → resume (no duplicate prompt)', () => {
    assert.deepEqual(
      routeCreationRequest({ status: 'pending', linkedProjectId: 'p2', leaseActive: false, unrelatedExisting: null }),
      { action: 'resume', projectId: 'p2' },
    )
  })
  it('4. error + project found by request identity → resume', () => {
    assert.deepEqual(
      routeCreationRequest({ status: 'error', linkedProjectId: 'p3', leaseActive: false, unrelatedExisting: null }),
      { action: 'resume', projectId: 'p3' },
    )
  })
  it('5. unrelated same-number project → duplicate_prompt', () => {
    assert.deepEqual(
      routeCreationRequest({ status: 'pending', linkedProjectId: null, leaseActive: false, unrelatedExisting: { id: 'other', name: 'Other' } }),
      { action: 'duplicate_prompt', existing: { id: 'other', name: 'Other' } },
    )
  })
  it('6. completed request performs no provisioning', () => {
    assert.deepEqual(
      routeCreationRequest({ status: 'completed', linkedProjectId: 'p1', leaseActive: false, unrelatedExisting: null }),
      { action: 'already_completed' },
    )
  })
  it('7. intentional duplicate (new request identity) remains possible via the prompt', () => {
    // A brand-new request for an existing number: no linked project of its own,
    // so it is offered the duplicate/replace/cancel decision (not auto-resumed).
    assert.deepEqual(
      routeCreationRequest({ status: 'pending', linkedProjectId: null, leaseActive: false, unrelatedExisting: { id: 'orig', name: 'Orig' } }),
      { action: 'duplicate_prompt', existing: { id: 'orig', name: 'Orig' } },
    )
  })
  it('awaiting_decision leaves the open prompt; clean request provisions', () => {
    assert.deepEqual(
      routeCreationRequest({ status: 'awaiting_decision', linkedProjectId: null, leaseActive: false, unrelatedExisting: null }),
      { action: 'awaiting_decision' },
    )
    assert.deepEqual(
      routeCreationRequest({ status: 'pending', linkedProjectId: null, leaseActive: false, unrelatedExisting: null }),
      { action: 'provision' },
    )
  })
})

describe('runDisabledCreation (disabled-path order)', () => {
  it('announces "Provisioning…" BEFORE inserting, and consults no store', async () => {
    const order: string[] = []
    const result = await runDisabledCreation({
      announce: async () => { order.push('announce') },
      insertProject: async () => { order.push('insert'); return { id: 'p1' } },
    })
    assert.deepEqual(order, ['announce', 'insert'])
    assert.equal(result.id, 'p1')
  })
})

describe('resolveCreationProject (creation gate)', () => {
  it('bypasses the ledger entirely when creation is disabled (store ops would throw)', async () => {
    const throwing: RequestStorePort = {
      getOrCreateCreationRequest: async () => { throw new Error('migration-056 not present') },
      loadCreationRequest: async () => { throw new Error('migration-056 not present') },
      updateCreationRequest: async () => { throw new Error('migration-056 not present') },
      claimCreationRequest: async () => { throw new Error('migration-056 not present') },
    }
    let inserted = 0
    const r = await resolveCreationProject(
      {
        store: throwing,
        insertProject: async () => { inserted++; return { id: 'p1' } },
        findProjectByRequestId: async () => { throw new Error('should not query') },
        holder: 'h',
        creationEnabled: false,
      },
      { requestKey: 'V1', workspaceId: 'w', requestedBy: 'U1', submission: {} },
    )
    assert.equal(r.status, 'created')
    assert.equal(r.projectId, 'p1')
    assert.equal(inserted, 1) // inserted directly, no store call
  })

  it('uses the durable ledger workflow when enabled', async () => {
    const store = new FakeStore()
    const counter = { n: 0 }
    const r = await resolveCreationProject(
      { ...makeDeps(store, counter), creationEnabled: true },
      { requestKey: 'V7', workspaceId: 'w', requestedBy: 'U1', submission: {} },
    )
    assert.equal(r.status, 'created')
    assert.equal(counter.n, 1)
  })
})
