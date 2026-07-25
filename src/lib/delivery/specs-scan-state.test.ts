/**
 * Lease + cursor tests for the specs-scan durable state, driven through the REAL
 * store functions with an injected in-memory Supabase fake (no DB).
 *
 * Run: npx tsx --test src/lib/delivery/specs-scan-state.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getSpecsScanState,
  claimSpecsScanLease,
  advanceSpecsScanCursor,
  releaseSpecsScanLease,
  __setSpecsScanStateClientForTests,
} from './specs-scan-state'

type Row = Record<string, unknown>

/** In-memory model of `delivery_specs_scan_state` honoring the store's chains. */
function fakeStateClient() {
  const rows = new Map<string, Row>()

  function builder() {
    let op: 'update' | 'upsert' | 'select' | null = null
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
        const id = values.id as string
        if (!rows.has(id)) {
          rows.set(id, {
            id,
            phase: 'bootstrap',
            cursor: null,
            lease_holder: null,
            lease_expires_at: null,
            fence: 0,
          })
        }
        return { data: null, error: null }
      }
      if (op === 'update') {
        const matched: Row[] = []
        for (const row of rows.values()) if (matches(row)) { Object.assign(row, values); matched.push(row) }
        return { data: selecting ? (matched[0] ?? null) : matched, error: null }
      }
      if (op === 'select') {
        const matched: Row[] = []
        for (const row of rows.values()) if (matches(row)) matched.push(row)
        return { data: selecting ? (matched[0] ?? null) : matched, error: null }
      }
      return { data: null, error: null }
    }

    const api = {
      upsert(v: Row) { op = 'upsert'; values = v; return api },
      update(v: Row) { op = 'update'; values = v; return api },
      select(cols?: string) { void cols; if (op == null) op = 'select'; selecting = true; return api },
      eq(c: string, v: unknown) { eqs.push([c, v]); return api },
      or(f: string) { orFilter = f; return api },
      async maybeSingle() { return run() },
      then(res: (r: { data: unknown; error: null }) => void, rej: (e: unknown) => void) {
        try { res(run()) } catch (e) { rej(e) }
      },
    }
    return api
  }

  return { rows, from: (t: string) => { void t; return builder() } }
}

afterEach(() => __setSpecsScanStateClientForTests(null))

describe('specs-scan lease + cursor', () => {
  it('claims, advances cursor holder+fence-conditionally, and releases', async () => {
    const fake = fakeStateClient()
    __setSpecsScanStateClientForTests(() => fake)

    const claim = await claimSpecsScanLease('A')
    assert.equal(claim.ok, true)
    assert.equal(claim.fence, 1)

    // Correct holder + fence advances the cursor.
    assert.equal(await advanceSpecsScanCursor('A', 1, { cursor: 'c1', phase: 'bootstrap' }), true)
    let state = await getSpecsScanState()
    assert.equal(state.cursor, 'c1')
    assert.equal(state.phase, 'bootstrap')

    // A stale fence is rejected (no clobber).
    assert.equal(await advanceSpecsScanCursor('A', 0, { cursor: 'STALE', phase: 'delta' }), false)
    state = await getSpecsScanState()
    assert.equal(state.cursor, 'c1')

    await releaseSpecsScanLease('A')
    state = await getSpecsScanState()
    assert.equal(state.lease_holder, null)
  })

  it('a contending run cannot claim while the lease is active', async () => {
    const fake = fakeStateClient()
    __setSpecsScanStateClientForTests(() => fake)

    assert.equal((await claimSpecsScanLease('A')).ok, true)
    // B contends while A holds a live lease → denied.
    const b = await claimSpecsScanLease('B')
    assert.equal(b.ok, false)
    assert.equal(b.fence, null)
  })

  it('an expired lease is reclaimed and fences out the crashed holder', async () => {
    const fake = fakeStateClient()
    __setSpecsScanStateClientForTests(() => fake)

    const a = await claimSpecsScanLease('A')
    assert.equal(a.ok, true)
    // A crashes; its lease expires.
    ;(fake.rows.get('singleton') as Row).lease_expires_at = new Date(Date.now() - 1000).toISOString()

    // B reclaims; fence bumps monotonically.
    const b = await claimSpecsScanLease('B')
    assert.equal(b.ok, true)
    assert.equal(b.fence, 2)

    // A's stale write at its old fence is rejected.
    assert.equal(await advanceSpecsScanCursor('A', a.fence!, { cursor: 'STALE', phase: 'delta' }), false)
    // B owns the cursor.
    assert.equal(await advanceSpecsScanCursor('B', b.fence!, { cursor: 'c-b', phase: 'delta' }), true)
    assert.equal((await getSpecsScanState()).cursor, 'c-b')
  })

  it('release is ownership-safe (wrong holder is a no-op)', async () => {
    const fake = fakeStateClient()
    __setSpecsScanStateClientForTests(() => fake)
    await claimSpecsScanLease('A')
    await releaseSpecsScanLease('someone-else')
    assert.equal((fake.rows.get('singleton') as Row).lease_holder, 'A')
    await releaseSpecsScanLease('A')
    assert.equal((fake.rows.get('singleton') as Row).lease_holder, null)
  })
})
