/**
 * Workbook lease tests — ownership-safe claim/release through the REAL store
 * functions, driven by an injected fake Supabase client (no DB).
 *
 * Run: npx tsx --test src/lib/project-control/store.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { claimWorkbookLease, releaseWorkbookLease, __setStoreClientForTests } from './store'

type Row = Record<string, unknown>

/**
 * Minimal in-memory model of `sheet_sync_state` that honors the exact query
 * chains the store uses: upsert; update+eq+eq; update+eq+or+select+maybeSingle.
 * Filters mirror the SQL: eq (equality) and or ("<col>.is.null,<col>.lt.<iso>").
 */
function fakeSyncStateClient() {
  const rows = new Map<string, Row>()

  function builder() {
    let op: 'update' | 'upsert' | null = null
    let values: Row = {}
    const eqs: Array<[string, unknown]> = []
    let orFilter: string | null = null
    let selecting = false

    const matches = (row: Row): boolean => {
      for (const [c, v] of eqs) if (row[c] !== v) return false
      if (orFilter) {
        const ok = orFilter.split(',').some((clause) => {
          const parts = clause.split('.')
          const col = parts[0], opName = parts[1], val = parts.slice(2).join('.')
          if (opName === 'is' && val === 'null') return row[col] == null
          if (opName === 'lt') return row[col] != null && String(row[col]) < val
          return false
        })
        if (!ok) return false
      }
      return true
    }

    const run = (): { data: unknown; error: null } => {
      if (op === 'upsert') {
        const id = values.spreadsheet_id as string
        if (!rows.has(id)) rows.set(id, { spreadsheet_id: id })
        return { data: null, error: null }
      }
      if (op === 'update') {
        const matched: Row[] = []
        for (const row of rows.values()) if (matches(row)) { Object.assign(row, values); matched.push(row) }
        return { data: selecting ? (matched[0] ?? null) : matched, error: null }
      }
      return { data: null, error: null }
    }

    const api = {
      upsert(v: Row) { op = 'upsert'; values = v; return api },
      update(v: Row) { op = 'update'; values = v; return api },
      eq(c: string, v: unknown) { eqs.push([c, v]); return api },
      or(f: string) { orFilter = f; return api },
      select(cols?: string) { void cols; selecting = true; return api },
      async maybeSingle() { return run() },
      then(res: (r: { data: unknown; error: null }) => void, rej: (e: unknown) => void) {
        try { res(run()) } catch (e) { rej(e) }
      },
    }
    return api
  }

  return { rows, from: (t: string) => { void t; return builder() } }
}

afterEach(() => __setStoreClientForTests(null))

describe('workbook lease (ownership-safe release)', () => {
  it('A cannot release B\'s reclaimed lease; a third worker is blocked until B releases', async () => {
    const fake = fakeSyncStateClient()
    __setStoreClientForTests(() => fake)

    // 1) A claims
    assert.equal(await claimWorkbookLease('sid', 'sync', 'A'), true)
    // 1) A's lease expires
    ;(fake.rows.get('sid') as Row).sync_lease_expires_at = new Date(Date.now() - 1000).toISOString()
    // 2) B reclaims
    assert.equal(await claimWorkbookLease('sid', 'sync', 'B'), true)
    assert.equal((fake.rows.get('sid') as Row).sync_lease_holder, 'B')

    // 3) A attempts release with its stale holder token → no-op
    await releaseWorkbookLease('sid', 'sync', 'A')
    // 4) B's lease remains active
    assert.equal((fake.rows.get('sid') as Row).sync_lease_holder, 'B')
    assert.ok((fake.rows.get('sid') as Row).sync_lease_expires_at)

    // 5) a third worker cannot claim while B holds it
    assert.equal(await claimWorkbookLease('sid', 'sync', 'C'), false)

    // B releases (correct holder) → then C can claim
    await releaseWorkbookLease('sid', 'sync', 'B')
    assert.equal((fake.rows.get('sid') as Row).sync_lease_holder, null)
    assert.equal(await claimWorkbookLease('sid', 'sync', 'C'), true)
  })

  it('creation lease release also requires the exact holder', async () => {
    const fake = fakeSyncStateClient()
    __setStoreClientForTests(() => fake)
    assert.equal(await claimWorkbookLease('sid', 'creation', 'A'), true)
    // Wrong holder cannot release.
    await releaseWorkbookLease('sid', 'creation', 'someone-else')
    assert.equal((fake.rows.get('sid') as Row).creation_lease_holder, 'A')
    // Correct holder releases.
    await releaseWorkbookLease('sid', 'creation', 'A')
    assert.equal((fake.rows.get('sid') as Row).creation_lease_holder, null)
  })
})
