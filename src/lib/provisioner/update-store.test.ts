/**
 * Update-store durability tests — decision compare-and-set, request-lease
 * fencing, and step claim/reuse/reclaim through the REAL store functions driven
 * by an injected in-memory fake Supabase client (no DB).
 *
 * Run: npx tsx --test src/lib/provisioner/update-store.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getOrCreateUpdateRequest,
  updateUpdateRequest,
  commitUpdateDecision,
  claimUpdateRequestFenced,
  renewUpdateRequestLease,
  claimUpdateStep,
  completeUpdateStep,
  getUpdateSteps,
  __setUpdateStoreClientForTests,
} from './update-store'

type Row = Record<string, unknown>

/**
 * Small multi-table in-memory Supabase model honoring the exact chains the
 * update-store uses: insert().select().single(); upsert(onConflict, ignoreDup);
 * select().eq()...maybeSingle(); update()...or().select().maybeSingle();
 * select().in().or() (thenable). Filters mirror the SQL: eq / neq / in / or
 * ("<col>.is.null,<col>.lt.<iso>" or "<col>.is.null").
 */
function fakeDb() {
  const tables = new Map<string, Row[]>()
  let seq = 0
  const tableOf = (t: string) => {
    if (!tables.has(t)) tables.set(t, [])
    return tables.get(t)!
  }

  function builder(table: string) {
    let op: 'select' | 'insert' | 'update' | 'upsert' | null = null
    let values: Row = {}
    let upsertOpts: Row = {}
    const eqs: Array<[string, unknown]> = []
    const neqs: Array<[string, unknown]> = []
    let inFilter: [string, unknown[]] | null = null
    let orFilter: string | null = null
    let selecting = false

    const orMatch = (row: Row): boolean => {
      if (!orFilter) return true
      return orFilter.split(',').some((clause) => {
        const [col, opName, ...rest] = clause.split('.')
        const val = rest.join('.')
        if (opName === 'is' && val === 'null') return row[col] == null
        if (opName === 'lt') return row[col] != null && String(row[col]) < val
        return false
      })
    }
    const matches = (row: Row): boolean => {
      for (const [c, v] of eqs) if (row[c] !== v) return false
      for (const [c, v] of neqs) if (row[c] === v) return false
      if (inFilter && !inFilter[1].includes(row[inFilter[0]])) return false
      return orMatch(row)
    }

    const run = (): { data: unknown; error: null } => {
      const rows = tableOf(table)
      if (op === 'insert') {
        const row: Row = { id: `${table}-${++seq}`, ...values }
        rows.push(row)
        return { data: selecting ? row : null, error: null }
      }
      if (op === 'upsert') {
        const conflict = String(upsertOpts.onConflict || '').split(',').filter(Boolean)
        const exists = rows.find((r) => conflict.every((c) => r[c] === values[c]))
        if (!exists) rows.push({ id: `${table}-${++seq}`, ...values })
        return { data: null, error: null }
      }
      if (op === 'update') {
        const matched: Row[] = []
        for (const r of rows) if (matches(r)) { Object.assign(r, values); matched.push(r) }
        return { data: selecting ? (matched[0] ?? null) : matched, error: null }
      }
      // select
      const matched = rows.filter(matches)
      return { data: selecting ? matched : matched, error: null }
    }

    const api: Row = {
      select(cols?: string) { void cols; selecting = true; if (!op) op = 'select'; return api },
      insert(v: Row) { op = 'insert'; values = v; return api },
      update(v: Row) { op = 'update'; values = v; return api },
      upsert(v: Row, o?: Row) { op = 'upsert'; values = v; upsertOpts = o || {}; return api },
      eq(c: string, v: unknown) { eqs.push([c, v]); return api },
      neq(c: string, v: unknown) { neqs.push([c, v]); return api },
      in(c: string, v: unknown[]) { inFilter = [c, v]; return api },
      or(f: string) { orFilter = f; return api },
      async maybeSingle() { const r = run(); const d = (r.data as Row[] | Row | null); return { data: Array.isArray(d) ? (d[0] ?? null) : d, error: null } },
      async single() { const r = run(); const d = (r.data as Row[] | Row | null); return { data: Array.isArray(d) ? (d[0] ?? null) : d, error: null } },
      then(res: (r: { data: unknown; error: null }) => void, rej: (e: unknown) => void) {
        try { res(run()) } catch (e) { rej(e) }
      },
    }
    return api
  }

  return { tables, from: (t: string) => builder(t) }
}

afterEach(() => __setUpdateStoreClientForTests(null))

async function seedRequest(fake: ReturnType<typeof fakeDb>, key = 'V1') {
  __setUpdateStoreClientForTests(() => fake)
  const { row, created } = await getOrCreateUpdateRequest({
    requestKey: key,
    workspaceId: 'WS',
    projectId: 'P1',
    requestedBy: 'U_STEVE',
    submission: { projectName: 'New Name' },
    plan: { hasChanges: true },
  })
  return { row, created }
}

describe('getOrCreateUpdateRequest', () => {
  it('creates once, then returns the same row (idempotent)', async () => {
    const fake = fakeDb()
    const a = await seedRequest(fake)
    assert.equal(a.created, true)
    const b = await seedRequest(fake)
    assert.equal(b.created, false)
    assert.equal(b.row.id, a.row.id)
  })
})

describe('commitUpdateDecision (one-winner CAS)', () => {
  it('only the first apply wins; later clicks lose', async () => {
    const fake = fakeDb()
    await seedRequest(fake)
    await updateUpdateRequest('V1', { status: 'awaiting_confirm' })

    const first = await commitUpdateDecision({ requestKey: 'V1', actingUserId: 'U_STEVE', workspaceId: 'WS', decision: 'apply' })
    const second = await commitUpdateDecision({ requestKey: 'V1', actingUserId: 'U_STEVE', workspaceId: 'WS', decision: 'apply' })
    assert.equal(first, true)
    assert.equal(second, false)
    assert.equal(fake.tables.get('project_update_requests')![0].status, 'applying')
    assert.equal(fake.tables.get('project_update_requests')![0].decision, 'apply')
  })

  it('rejects a different requester', async () => {
    const fake = fakeDb()
    await seedRequest(fake)
    await updateUpdateRequest('V1', { status: 'awaiting_confirm' })
    const other = await commitUpdateDecision({ requestKey: 'V1', actingUserId: 'U_INTRUDER', workspaceId: 'WS', decision: 'apply' })
    assert.equal(other, false)
  })

  it('cancel is terminal and blocks a later apply', async () => {
    const fake = fakeDb()
    await seedRequest(fake)
    await updateUpdateRequest('V1', { status: 'awaiting_confirm' })
    assert.equal(await commitUpdateDecision({ requestKey: 'V1', actingUserId: 'U_STEVE', workspaceId: 'WS', decision: 'cancel' }), true)
    assert.equal(fake.tables.get('project_update_requests')![0].status, 'cancelled')
    assert.equal(await commitUpdateDecision({ requestKey: 'V1', actingUserId: 'U_STEVE', workspaceId: 'WS', decision: 'apply' }), false)
  })
})

describe('request lease fencing', () => {
  it('reclaim bumps the fence; the stale holder cannot renew', async () => {
    const fake = fakeDb()
    await seedRequest(fake)
    const a = await claimUpdateRequestFenced('V1', 'A')
    assert.equal(a.ok, true)
    assert.equal(a.fence, 1)
    // expire A's lease
    fake.tables.get('project_update_requests')![0].lease_expires_at = new Date(Date.now() - 1000).toISOString()
    const b = await claimUpdateRequestFenced('V1', 'B')
    assert.equal(b.ok, true)
    assert.equal(b.fence, 2)
    // A can no longer renew; B can
    assert.equal(await renewUpdateRequestLease('V1', 'A'), false)
    assert.equal(await renewUpdateRequestLease('V1', 'B'), true)
    // C is blocked while B holds an active lease
    assert.equal((await claimUpdateRequestFenced('V1', 'C')).ok, false)
  })
})

describe('step claim / complete / reclaim', () => {
  it('a done step is reused (not re-run); a failed step is reclaimable', async () => {
    const fake = fakeDb()
    await seedRequest(fake)
    const rid = fake.tables.get('project_update_requests')![0].id as string

    // Claim + complete slack as done.
    const c1 = await claimUpdateStep(rid, 'P1', 'slack', 'A')
    assert.equal(c1.ok, true)
    assert.equal(c1.fence, 1)
    assert.equal(await completeUpdateStep(rid, 'slack', 'A', 1, { status: 'done', result: { success: true } }), true)

    // Re-claim slack → refused with status 'done' (reuse memoized result).
    const c2 = await claimUpdateStep(rid, 'P1', 'slack', 'A')
    assert.equal(c2.ok, false)
    assert.equal(c2.status, 'done')

    // Dropbox fails (retryable) → a later claim reclaims it.
    const d1 = await claimUpdateStep(rid, 'P1', 'dropbox', 'A')
    assert.equal(d1.ok, true)
    assert.equal(await completeUpdateStep(rid, 'dropbox', 'A', d1.fence as number, { status: 'failed', error: 'boom' }), true)
    const d2 = await claimUpdateStep(rid, 'P1', 'dropbox', 'A')
    assert.equal(d2.ok, true) // reclaimable

    const steps = await getUpdateSteps(rid)
    assert.equal(steps.length, 2)
  })

  it('a stale holder/fence cannot complete over a newer claim', async () => {
    const fake = fakeDb()
    await seedRequest(fake)
    const rid = fake.tables.get('project_update_requests')![0].id as string
    const first = await claimUpdateStep(rid, 'P1', 'harvest', 'A')
    // expire A's lease, B reclaims → fence bumps
    fake.tables.get('project_update_steps')![0].lease_expires_at = new Date(Date.now() - 1000).toISOString()
    const second = await claimUpdateStep(rid, 'P1', 'harvest', 'B')
    assert.equal(second.ok, true)
    // A's stale fenced write is rejected; B's succeeds.
    assert.equal(await completeUpdateStep(rid, 'harvest', 'A', first.fence as number, { status: 'done' }), false)
    assert.equal(await completeUpdateStep(rid, 'harvest', 'B', second.fence as number, { status: 'done' }), true)
  })
})
