/**
 * Frontier store tests — the REAL enqueue/load functions plus the atomic
 * checkpoint wrappers (commitBacklogFolder / markBacklogCompleteIfEmpty),
 * driven by an injected in-memory Supabase fake. The fake's `.rpc()` mirrors the
 * migration-061 Postgres functions' contract: mutate ONLY when the caller owns
 * the lease at its fence, all-or-nothing, and never complete while the frontier
 * is non-empty. (The real SQL must additionally be exercised on a Supabase
 * branch/staging before rollout — see the PR report.)
 *
 * Run: npx tsx --test src/lib/delivery/specs-scan-frontier.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  enqueueFrontier,
  loadFrontierBatch,
  commitBacklogFolder,
  markBacklogCompleteIfEmpty,
  __setSpecsFrontierClientForTests,
} from './specs-scan-frontier'

/**
 * In-memory model: a frontier map + a singleton lease state, wired so `.rpc()`
 * enforces the same holder+fence ownership + atomicity the SQL functions do.
 */
function fakeFrontierClient(state = { lease_holder: 'A', fence: 1, backlog_complete: false }) {
  const rows = new Map<string, { path: string; created_at: number }>()
  let seq = 0

  const owned = (h: string, f: number) => state.lease_holder === h && state.fence === f

  function builder() {
    let op: 'upsert' | 'select' | null = null
    let values: any = null
    let limitN: number | null = null
    function run(): { data: unknown; error: null } {
      if (op === 'upsert') {
        const arr = Array.isArray(values) ? values : [values]
        for (const r of arr) if (!rows.has(r.path)) rows.set(r.path, { path: r.path, created_at: seq++ })
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
      then(res: (r: any) => void, rej: (e: unknown) => void) { try { res(run()) } catch (e) { rej(e) } },
    }
    return api
  }

  return {
    rows,
    state,
    from: (_t: string) => builder(),
    async rpc(name: string, p: any) {
      if (name === 'specs_backlog_commit_folder') {
        if (!owned(p.p_holder, p.p_fence)) return { data: false, error: null } // no mutation
        for (const c of p.p_children || []) if (!rows.has(c)) rows.set(c, { path: c, created_at: seq++ })
        rows.delete(p.p_parent)
        return { data: true, error: null }
      }
      if (name === 'specs_backlog_mark_complete_if_empty') {
        if (!owned(p.p_holder, p.p_fence)) return { data: false, error: null }
        if (rows.size > 0) return { data: false, error: null } // never complete while non-empty
        state.backlog_complete = true
        return { data: true, error: null }
      }
      throw new Error(`unexpected rpc ${name}`)
    },
  }
}

afterEach(() => __setSpecsFrontierClientForTests(null))

describe('specs-scan frontier — enqueue/load', () => {
  it('enqueues idempotently and drains oldest-first', async () => {
    const fake = fakeFrontierClient()
    __setSpecsFrontierClientForTests(() => fake)
    await enqueueFrontier(['/production'])
    await enqueueFrontier(['/production/2026', '/production/2025'])
    await enqueueFrontier(['/production']) // dup — no reorder/dup
    assert.equal(fake.rows.size, 3)
    assert.deepEqual(await loadFrontierBatch(2), ['/production', '/production/2026'])
  })

  it('enqueue of an empty list is a no-op', async () => {
    const fake = fakeFrontierClient()
    __setSpecsFrontierClientForTests(() => fake)
    await enqueueFrontier([])
    assert.equal(fake.rows.size, 0)
  })
})

describe('specs-scan frontier — atomic checkpoint (holder+fence)', () => {
  it('a stale holder cannot enqueue children or delete the parent (all-or-nothing)', async () => {
    const fake = fakeFrontierClient({ lease_holder: 'A', fence: 2, backlog_complete: false })
    __setSpecsFrontierClientForTests(() => fake)
    await enqueueFrontier(['/production'])

    // Wrong holder → no mutation at all.
    assert.equal(await commitBacklogFolder('STALE', 2, '/production', ['/production/2026']), false)
    assert.equal(fake.rows.has('/production'), true) // parent NOT deleted
    assert.equal(fake.rows.has('/production/2026'), false) // children NOT enqueued

    // Stale fence → no mutation at all.
    assert.equal(await commitBacklogFolder('A', 1, '/production', ['/production/2026']), false)
    assert.equal(fake.rows.has('/production'), true)
    assert.equal(fake.rows.has('/production/2026'), false)
  })

  it('the real owner commits children + parent-delete atomically; retry after a stale reject is safe', async () => {
    const fake = fakeFrontierClient({ lease_holder: 'A', fence: 2, backlog_complete: false })
    __setSpecsFrontierClientForTests(() => fake)
    await enqueueFrontier(['/production'])

    // A stale attempt changed nothing (above contract); the real owner now commits.
    assert.equal(await commitBacklogFolder('STALE', 2, '/production', ['/production/2026']), false)
    assert.equal(await commitBacklogFolder('A', 2, '/production', ['/production/2026']), true)
    assert.equal(fake.rows.has('/production'), false) // parent deleted
    assert.equal(fake.rows.has('/production/2026'), true) // child enqueued
  })

  it('a stale holder cannot mark backlog complete', async () => {
    const fake = fakeFrontierClient({ lease_holder: 'A', fence: 2, backlog_complete: false })
    __setSpecsFrontierClientForTests(() => fake)
    assert.equal(await markBacklogCompleteIfEmpty('STALE', 2), false)
    assert.equal(await markBacklogCompleteIfEmpty('A', 1), false)
    assert.equal(fake.state.backlog_complete, false)
  })

  it('backlog cannot be marked complete while any frontier row exists', async () => {
    const fake = fakeFrontierClient({ lease_holder: 'A', fence: 2, backlog_complete: false })
    __setSpecsFrontierClientForTests(() => fake)
    await enqueueFrontier(['/production'])
    assert.equal(await markBacklogCompleteIfEmpty('A', 2), false) // non-empty → refused
    assert.equal(fake.state.backlog_complete, false)

    // Drain, then completion is allowed for the owner.
    assert.equal(await commitBacklogFolder('A', 2, '/production', []), true)
    assert.equal(await markBacklogCompleteIfEmpty('A', 2), true)
    assert.equal(fake.state.backlog_complete, true)
  })
})
