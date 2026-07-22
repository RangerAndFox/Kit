/**
 * Durability store tests — renewable/fenced leases, per-service step ledger, and
 * the recovery work-list queries, through the REAL store functions driven by an
 * injected generic in-memory Supabase fake (no DB).
 *
 * Run: npx tsx --test src/lib/project-control/store-durability.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  __setStoreClientForTests,
  claimWorkbookLease,
  claimWorkbookLeaseFenced,
  renewWorkbookLease,
  releaseWorkbookLease,
  claimCreationRequestFenced,
  renewCreationRequestLease,
  listRecoverableRequests,
  listProjectsWithIncompleteSteps,
  listIncompleteBindings,
  listSyncableBindings,
  getProvisioningSteps,
  claimProvisioningStep,
  completeProvisioningStep,
  commitCreationDecision,
} from './store'

type Row = Record<string, unknown>

/**
 * Generic in-memory Supabase model honoring the query chains the store uses:
 * select/insert/update/upsert with eq/neq/in/or filters, maybeSingle (single
 * row) vs awaited (array), and upsert onConflict (merge unless ignoreDuplicates).
 */
function fakeDb() {
  const tables = new Map<string, Row[]>()
  const rowsOf = (t: string) => tables.get(t) ?? (tables.set(t, []), tables.get(t)!)
  // Set to a message to simulate a Supabase read/write error on the next runs.
  const state: { forceError: string | null } = { forceError: null }

  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' | 'upsert' | null = null
    let values: Row = {}
    let conflict: string[] = []
    let ignoreDup = false
    const eqs: Array<[string, unknown]> = []
    const neqs: Array<[string, unknown]> = []
    const ins: Array<[string, unknown[]]> = []
    let orFilter: string | null = null

    const matches = (row: Row): boolean => {
      for (const [c, v] of eqs) if (row[c] !== v) return false
      for (const [c, v] of neqs) if (row[c] === v) return false
      for (const [c, vals] of ins) if (!vals.includes(row[c])) return false
      if (orFilter) {
        const ok = orFilter.split(',').some((clause) => {
          const [col, opName, ...rest] = clause.split('.')
          const val = rest.join('.')
          if (opName === 'is' && val === 'null') return row[col] == null
          if (opName === 'lt') return row[col] != null && String(row[col]) < val
          return false
        })
        if (!ok) return false
      }
      return true
    }

    const run = (single: boolean): { data: unknown; error: { message: string } | null } => {
      if (state.forceError) return { data: null, error: { message: state.forceError } }
      const rows = rowsOf(table)
      if (op === 'insert') {
        const created = { ...values }
        rows.push(created)
        return { data: single ? created : [created], error: null }
      }
      if (op === 'upsert') {
        const found = rows.find((r) => conflict.every((k) => r[k] === values[k]))
        if (found) { if (!ignoreDup) Object.assign(found, values) }
        else rows.push({ ...values })
        return { data: null, error: null }
      }
      if (op === 'update') {
        const matched = rows.filter(matches)
        for (const r of matched) Object.assign(r, values)
        return { data: single ? (matched[0] ?? null) : matched, error: null }
      }
      // select
      const matched = rows.filter(matches)
      return { data: single ? (matched[0] ?? null) : matched, error: null }
    }

    // Terminal/filter stage — filters + shapers live ONLY here, matching the
    // real client. `select` here is the returning-refinement (never resets op).
    const filter = {
      select(_c?: string) { void _c; return filter },
      eq(c: string, v: unknown) { eqs.push([c, v]); return filter },
      neq(c: string, v: unknown) { neqs.push([c, v]); return filter },
      in(c: string, v: unknown[]) { ins.push([c, v]); return filter },
      or(f: string) { orFilter = f; return filter },
      async maybeSingle() { return run(true) },
      async single() { return run(true) },
      then(
        res: (r: { data: unknown; error: { message: string } | null }) => void,
        rej: (e: unknown) => void,
      ) {
        try { res(run(false)) } catch (e) { rej(e) }
      },
    }
    // Table stage — only a read/write verb; NO filter methods exist yet, so a
    // filter-before-select (e.g. from().in(...)) throws "in is not a function",
    // exactly as the real @supabase/postgrest-js builder does.
    const table_ = {
      select(_c?: string) { void _c; if (!op) op = 'select'; return filter },
      insert(v: Row) { op = 'insert'; values = v; return filter },
      update(v: Row) { op = 'update'; values = v; return filter },
      upsert(v: Row, opts?: Row) {
        op = 'upsert'; values = v
        conflict = String(opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        ignoreDup = opts?.ignoreDuplicates === true
        return filter
      },
    }
    return table_
  }

  return {
    tables,
    rowsOf,
    from: (t: string) => builder(t),
    /** Make subsequent reads/writes return a Supabase error (to test throw-not-empty). */
    failWith(msg: string | null) { state.forceError = msg },
  }
}

afterEach(() => __setStoreClientForTests(null))

describe('renewable / fenced workbook lease', () => {
  it('renew extends the expiry only for the current holder and never changes the fence', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)

    const claim = await claimWorkbookLeaseFenced('sid', 'creation', 'A')
    assert.equal(claim.ok, true)
    assert.equal(claim.fence, 1)
    const row = () => fake.rowsOf('sheet_sync_state')[0]
    const firstExpiry = row().creation_lease_expires_at

    // Wrong holder cannot renew.
    assert.equal(await renewWorkbookLease('sid', 'creation', 'B'), false)
    // Correct holder renews; fence unchanged; expiry not moved backwards.
    assert.equal(await renewWorkbookLease('sid', 'creation', 'A'), true)
    assert.equal(row().creation_fence, 1)
    assert.ok(String(row().creation_lease_expires_at) >= String(firstExpiry))
  })

  it('a reclaim after expiry bumps the fence monotonically', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    const row = () => fake.rowsOf('sheet_sync_state')[0]

    assert.equal((await claimWorkbookLeaseFenced('sid', 'creation', 'A')).fence, 1)
    row().creation_lease_expires_at = new Date(Date.now() - 1000).toISOString()
    const reclaim = await claimWorkbookLeaseFenced('sid', 'creation', 'B')
    assert.equal(reclaim.ok, true)
    assert.equal(reclaim.fence, 2)
    assert.equal(row().creation_lease_holder, 'B')

    // A third worker cannot claim while B holds it (no fence granted).
    const blocked = await claimWorkbookLeaseFenced('sid', 'creation', 'C')
    assert.equal(blocked.ok, false)
    assert.equal(blocked.fence, null)
  })

  it('stale worker A is rejected at the ownership check after B reclaims (before any write)', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    const row = () => fake.rowsOf('sheet_sync_state')[0]

    // 1) A acquires.
    assert.equal((await claimWorkbookLeaseFenced('sid', 'creation', 'A')).ok, true)
    // 2) A's lease expires.
    row().creation_lease_expires_at = new Date(Date.now() - 1000).toISOString()
    // 3) B reclaims.
    assert.equal((await claimWorkbookLeaseFenced('sid', 'creation', 'B')).ok, true)
    // 4/5) A attempts its next write — its pre-write ownership check (renew) is
    //      REJECTED, so A never reaches the external boundary.
    assert.equal(await renewWorkbookLease('sid', 'creation', 'A'), false)
    // 6) B proceeds (its ownership check passes).
    assert.equal(await renewWorkbookLease('sid', 'creation', 'B'), true)
    // A's holder-qualified release cannot clear B's lease.
    await releaseWorkbookLease('sid', 'creation', 'A')
    assert.equal(row().creation_lease_holder, 'B')
  })

  it('the boolean claimWorkbookLease still works (delegates to fenced)', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    assert.equal(await claimWorkbookLease('sid', 'sync', 'A'), true)
    assert.equal(await claimWorkbookLease('sid', 'sync', 'B'), false)
  })
})

describe('renewable / fenced creation-request lease', () => {
  it('claims with a monotonic fence and renews only for the holder', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    // Seed the request row (get-or-create is exercised elsewhere).
    fake.rowsOf('project_creation_requests').push({
      request_key: 'V1', status: 'pending', fence: 0, lease_expires_at: null, claimed_by: null,
    })
    const row = () => fake.rowsOf('project_creation_requests')[0]

    const c1 = await claimCreationRequestFenced('V1', 'A')
    assert.deepEqual([c1.ok, c1.fence], [true, 1])
    // Renew by the wrong holder fails; by the right holder succeeds, fence held.
    assert.equal(await renewCreationRequestLease('V1', 'B'), false)
    assert.equal(await renewCreationRequestLease('V1', 'A'), true)
    assert.equal(row().fence, 1)

    // Expire → reclaim bumps to 2.
    row().lease_expires_at = new Date(Date.now() - 1000).toISOString()
    const c2 = await claimCreationRequestFenced('V1', 'B')
    assert.deepEqual([c2.ok, c2.fence], [true, 2])
  })
})

describe('recovery work-list queries', () => {
  it('lists only nonterminal, unleased requests', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    const future = new Date(Date.now() + 60_000).toISOString()
    fake.rowsOf('project_creation_requests').push(
      { request_key: 'pending', status: 'pending', lease_expires_at: null },
      { request_key: 'provisioning', status: 'provisioning', lease_expires_at: null },
      { request_key: 'leased', status: 'provisioning', lease_expires_at: future }, // active lease → excluded
      { request_key: 'completed', status: 'completed', lease_expires_at: null }, // terminal → excluded
      { request_key: 'cancelled', status: 'cancelled', lease_expires_at: null }, // terminal → excluded
    )
    const got = (await listRecoverableRequests()).map((r) => r.request_key).sort()
    assert.deepEqual(got, ['pending', 'provisioning'])
  })

  it('lists bindings that never reached connected', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    fake.rowsOf('project_control_bindings').push(
      { project_id: 'p1', spreadsheet_id: 'sid', creation_state: 'sheet_bound' },
      { project_id: 'p2', spreadsheet_id: 'sid', creation_state: 'connected' }, // excluded
      { project_id: 'p3', spreadsheet_id: 'sid', creation_state: 'pending_canvas' },
      { project_id: 'p4', spreadsheet_id: 'other', creation_state: 'sheet_bound' }, // other workbook
    )
    const got = (await listIncompleteBindings('sid')).map((b) => b.project_id).sort()
    assert.deepEqual(got, ['p1', 'p3'])
  })
})

describe('commitCreationDecision (atomic duplicate/replace/cancel CAS)', () => {
  function seedAwaiting() {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    fake.rowsOf('project_creation_requests').push({
      request_key: 'V1', status: 'awaiting_decision', decision: null,
      requested_by_slack_user_id: 'U', workspace_id: 'W', replace_target_project_id: 'OLD',
    })
    return fake
  }

  it('only the FIRST competing click wins; a racing click loses', async () => {
    const fake = seedAwaiting()
    const row = () => fake.rowsOf('project_creation_requests')[0]
    // duplicate wins...
    assert.equal(await commitCreationDecision({ requestKey: 'V1', actingUserId: 'U', workspaceId: 'W', decision: 'duplicate' }), true)
    assert.equal(row().decision, 'duplicate')
    assert.equal(row().status, 'provisioning')
    // ...a racing replace loses (no longer awaiting_decision / decision set).
    assert.equal(await commitCreationDecision({ requestKey: 'V1', actingUserId: 'U', workspaceId: 'W', decision: 'replace' }), false)
    assert.equal(row().decision, 'duplicate') // unchanged
  })

  it('rejects a non-requester and a wrong workspace', async () => {
    const fake = seedAwaiting()
    assert.equal(await commitCreationDecision({ requestKey: 'V1', actingUserId: 'OTHER', workspaceId: 'W', decision: 'replace' }), false)
    assert.equal(await commitCreationDecision({ requestKey: 'V1', actingUserId: 'U', workspaceId: 'OTHER', decision: 'replace' }), false)
    assert.equal(fake.rowsOf('project_creation_requests')[0].status, 'awaiting_decision')
  })

  it('cancel transitions to terminal cancelled and then blocks a later decision', async () => {
    const fake = seedAwaiting()
    assert.equal(await commitCreationDecision({ requestKey: 'V1', actingUserId: 'U', workspaceId: 'W', decision: 'cancel' }), true)
    assert.equal(fake.rowsOf('project_creation_requests')[0].status, 'cancelled')
    assert.equal(await commitCreationDecision({ requestKey: 'V1', actingUserId: 'U', workspaceId: 'W', decision: 'replace' }), false)
  })
})

describe('per-service provisioning step ownership', () => {
  it('claim → complete is holder+fence-conditional; a stale worker cannot commit', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)

    const c = await claimProvisioningStep('proj', 'dropbox', 'A')
    assert.equal(c.ok, true)
    assert.equal(c.fence, 1)

    // Wrong holder cannot commit; correct holder + wrong fence cannot commit.
    assert.equal(await completeProvisioningStep('proj', 'dropbox', 'B', 1, { status: 'done' }), false)
    assert.equal(await completeProvisioningStep('proj', 'dropbox', 'A', 999, { status: 'done' }), false)

    // Correct holder + fence commits.
    assert.equal(
      await completeProvisioningStep('proj', 'dropbox', 'A', 1, { status: 'done', result: { url: 'db' } }),
      true,
    )
    const steps = await getProvisioningSteps('proj')
    assert.equal(steps.find((s) => s.service === 'dropbox')?.status, 'done')

    // A done step is never re-claimed.
    const c2 = await claimProvisioningStep('proj', 'dropbox', 'A')
    assert.equal(c2.ok, false)
    assert.equal(c2.status, 'done')
  })

  it('a second claimant is blocked while the first holds an active lease', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    assert.equal((await claimProvisioningStep('proj', 'slack', 'A')).ok, true)
    assert.equal((await claimProvisioningStep('proj', 'slack', 'B')).ok, false)
  })

  it('getProvisioningSteps THROWS on a store error (never an empty ledger)', async () => {
    __setStoreClientForTests(() => ({
      from: () => ({
        select: () => ({ eq: () => ({ then: (res: (r: unknown) => void) => res({ data: null, error: { message: 'db down' } }) }) }),
      }),
    }) as unknown as ReturnType<typeof fakeDb>)
    await assert.rejects(getProvisioningSteps('proj'), /db down/)
  })
})

describe('recovery work-list reads — production-compatible builder ordering', () => {
  const past = new Date(Date.now() - 60_000).toISOString()
  const future = new Date(Date.now() + 60_000).toISOString()

  it('listRecoverableRequests runs select-before-filters and returns only eligible rows', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    // Seed directly (bypassing insert) so we control lease/status precisely.
    fake.rowsOf('project_creation_requests').push(
      { request_key: 'r-provisioning-expired', status: 'provisioning', lease_expires_at: past }, // eligible (preserved shape)
      { request_key: 'r-error-null', status: 'error', lease_expires_at: null },                   // eligible
      { request_key: 'r-completed', status: 'completed', lease_expires_at: null },                 // excluded (terminal)
      { request_key: 'r-active-lease', status: 'provisioning', lease_expires_at: future },         // excluded (live worker)
      { request_key: 'r-cancelled', status: 'cancelled', lease_expires_at: null },                 // excluded (terminal)
    )
    const out = await listRecoverableRequests()
    assert.deepEqual(
      out.map((r) => r.request_key).sort(),
      ['r-error-null', 'r-provisioning-expired'],
    )
  })

  it('the preserved V0BJU8Y5ESZ request shape is eligible for recovery', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    fake.rowsOf('project_creation_requests').push({
      request_key: 'V0BJU8Y5ESZ',
      status: 'provisioning',
      decision: 'create',
      error: 'incomplete_steps(retryable): frameio',
      attempts: 0,
      lease_expires_at: '2026-07-22T02:14:04.187+00:00', // long expired → reclaimable
    })
    const out = await listRecoverableRequests()
    assert.deepEqual(out.map((r) => r.request_key), ['V0BJU8Y5ESZ'])
  })

  it('listProjectsWithIncompleteSteps runs select-before-filters and dedupes eligible project ids', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    fake.rowsOf('project_provisioning_steps').push(
      { project_id: 'projA', service: 'frameio', status: 'failed', lease_expires_at: past }, // eligible
      { project_id: 'projA', service: 'harvest', status: 'done', lease_expires_at: null },   // excluded (done)
      { project_id: 'projB', service: 'slack', status: 'pending', lease_expires_at: null },  // eligible
      { project_id: 'projC', service: 'x', status: 'running', lease_expires_at: future },     // excluded (active lease)
    )
    const out = await listProjectsWithIncompleteSteps()
    assert.deepEqual(out.sort(), ['projA', 'projB'])
  })

  it('a DB error THROWS from each recovery read (never an empty work list)', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)
    fake.failWith('connection reset')
    await assert.rejects(listRecoverableRequests(), /listRecoverableRequests: connection reset/)
    await assert.rejects(listProjectsWithIncompleteSteps(), /listProjectsWithIncompleteSteps: connection reset/)
    await assert.rejects(listIncompleteBindings('sid'), /listIncompleteBindings: connection reset/)
    await assert.rejects(listSyncableBindings('sid'), /listSyncableBindings: connection reset/)
  })

  it('the fake rejects a filter invoked BEFORE select (reproduces the production TypeError)', () => {
    const fake = fakeDb()
    // The real production defect: from(...).in(...) before select(...).
    const tb = fake.from('project_creation_requests') as { in?: (c: string, v: unknown[]) => unknown }
    assert.equal(typeof tb.in, 'undefined')
    assert.throws(() => (tb.in as (c: string, v: unknown[]) => unknown)('status', []), TypeError)
    // The valid ordering exposes the filter only after select().
    const filter = fake.from('project_creation_requests').select('*') as { in?: unknown }
    assert.equal(typeof filter.in, 'function')
  })
})
