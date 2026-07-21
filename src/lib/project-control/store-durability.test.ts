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
  claimCreationRequestFenced,
  renewCreationRequestLease,
  listRecoverableRequests,
  listIncompleteBindings,
  getProvisioningSteps,
  upsertProvisioningStep,
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

    const run = (single: boolean): { data: unknown; error: null } => {
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

    const api = {
      select(_c?: string) { if (!op) op = 'select'; return api },
      insert(v: Row) { op = 'insert'; values = v; return api },
      update(v: Row) { op = 'update'; values = v; return api },
      upsert(v: Row, opts?: Row) {
        op = 'upsert'; values = v
        conflict = String(opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        ignoreDup = opts?.ignoreDuplicates === true
        return api
      },
      eq(c: string, v: unknown) { eqs.push([c, v]); return api },
      neq(c: string, v: unknown) { neqs.push([c, v]); return api },
      in(c: string, v: unknown[]) { ins.push([c, v]); return api },
      or(f: string) { orFilter = f; return api },
      async maybeSingle() { return run(true) },
      async single() { return run(true) },
      then(res: (r: { data: unknown; error: null }) => void, rej: (e: unknown) => void) {
        try { res(run(false)) } catch (e) { rej(e) }
      },
    }
    return api
  }

  return { tables, rowsOf, from: (t: string) => builder(t) }
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
    // Correct holder renews; fence unchanged.
    assert.equal(await renewWorkbookLease('sid', 'creation', 'A'), true)
    assert.equal(row().creation_fence, 1)
    assert.notEqual(row().creation_lease_expires_at, firstExpiry)
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

describe('per-service provisioning step ledger', () => {
  it('upserts by (project, service) and reads back per project', async () => {
    const fake = fakeDb()
    __setStoreClientForTests(() => fake)

    await upsertProvisioningStep('proj', 'dropbox', { status: 'running' })
    await upsertProvisioningStep('proj', 'dropbox', { status: 'done', result: { url: 'db' } })
    await upsertProvisioningStep('proj', 'frameio', { status: 'done', result: { url: 'f' } })
    await upsertProvisioningStep('other', 'dropbox', { status: 'done' })

    const steps = await getProvisioningSteps('proj')
    assert.equal(steps.length, 2) // dropbox merged (not duplicated), frameio added
    const dropbox = steps.find((s) => s.service === 'dropbox')!
    assert.equal(dropbox.status, 'done')
    assert.equal((dropbox.result as Row).url, 'db')
  })
})
