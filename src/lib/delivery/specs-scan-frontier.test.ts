/**
 * Frontier store tests — the REAL enqueue/load/delete functions driven by an
 * injected in-memory Supabase fake (no DB). Proves idempotent enqueue and
 * deterministic oldest-first drain order.
 *
 * Run: npx tsx --test src/lib/delivery/specs-scan-frontier.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  enqueueFrontier,
  loadFrontierBatch,
  deleteFrontierPath,
  __setSpecsFrontierClientForTests,
} from './specs-scan-frontier'

/** In-memory model of delivery_specs_scan_frontier honoring the store's chains. */
function fakeFrontierClient() {
  const rows = new Map<string, { path: string; created_at: number }>()
  let seq = 0

  function builder() {
    let op: 'upsert' | 'delete' | 'select' | null = null
    let values: any = null
    let limitN: number | null = null
    const eqs: Array<[string, unknown]> = []

    function run(): { data: unknown; error: null } {
      if (op === 'upsert') {
        const arr = Array.isArray(values) ? values : [values]
        for (const r of arr) if (!rows.has(r.path)) rows.set(r.path, { path: r.path, created_at: seq++ })
        return { data: null, error: null }
      }
      if (op === 'delete') {
        for (const [c, v] of eqs) if (c === 'path') rows.delete(v as string)
        return { data: null, error: null }
      }
      let list = [...rows.values()]
      list.sort((a, b) => a.created_at - b.created_at || a.path.localeCompare(b.path))
      if (limitN != null) list = list.slice(0, limitN)
      return { data: list.map((r) => ({ path: r.path })), error: null }
    }

    const api: any = {
      upsert(v: any) { op = 'upsert'; values = v; return api },
      select() { if (!op) op = 'select'; return api },
      order() { return api },
      limit(n: number) { limitN = n; return api },
      delete() { op = 'delete'; return api },
      eq(c: string, v: unknown) { eqs.push([c, v]); return api },
      then(res: (r: any) => void, rej: (e: unknown) => void) { try { res(run()) } catch (e) { rej(e) } },
    }
    return api
  }
  return { rows, from: (_t: string) => builder() }
}

afterEach(() => __setSpecsFrontierClientForTests(null))

describe('specs-scan frontier', () => {
  it('enqueues idempotently and drains oldest-first', async () => {
    const fake = fakeFrontierClient()
    __setSpecsFrontierClientForTests(() => fake)

    await enqueueFrontier(['/production'])
    await enqueueFrontier(['/production/2026', '/production/2025'])
    // Re-enqueue an existing path — must NOT duplicate or reorder it.
    await enqueueFrontier(['/production'])

    assert.equal(fake.rows.size, 3)
    const batch = await loadFrontierBatch(2)
    assert.deepEqual(batch, ['/production', '/production/2026']) // oldest-first

    await deleteFrontierPath('/production')
    const after = await loadFrontierBatch(10)
    assert.deepEqual(after, ['/production/2026', '/production/2025'])
  })

  it('enqueue of an empty list is a no-op', async () => {
    const fake = fakeFrontierClient()
    __setSpecsFrontierClientForTests(() => fake)
    await enqueueFrontier([])
    assert.equal(fake.rows.size, 0)
  })
})
