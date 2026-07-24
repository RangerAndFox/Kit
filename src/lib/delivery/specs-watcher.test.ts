/**
 * Bounded specs-scan orchestrator tests. `runSpecsScanTick` takes injectable
 * dependencies, so these drive it with in-memory fakes (no DB, no Dropbox, no
 * Slack) and assert the durable behavior: bounded bootstrap across invocations,
 * bootstrap→delta transition with no full-tree restart, the two-sighting gate,
 * dedup/pairing, and the post-then-mark idempotency contract.
 *
 * Run: npx tsx --test src/lib/delivery/specs-watcher.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runSpecsScanTick,
  planDiscoveryCall,
  nextPhase,
  decideStability,
  type SpecsScanDeps,
} from './specs-watcher'

const LEASE_MS = 4 * 60 * 1000
const ROOT = '/production'

type SeenRow = {
  dropbox_id: string
  path: string
  size_bytes: number | null
  notified_at: string | null
  stable_check_count: number | null
}

function fileEntry(id: string, path: string, size: number) {
  const name = path.split('/').pop()!
  return { '.tag': 'file', id, name, path_display: path, path_lower: path.toLowerCase(), size }
}

interface HarnessOpts {
  ledger?: SeenRow[]
  discoveryPages?: Array<{ entries: any[]; hasMore: boolean }>
  folders?: Record<string, any[]>
  channels?: Record<string, { projectId: string; name: string; channelId: string | null }>
  state?: Partial<{ phase: 'bootstrap' | 'delta'; cursor: string | null }>
  postFails?: boolean
  markThrows?: boolean
}

function makeHarness(opts: HarnessOpts = {}) {
  const clock = { t: 1_000_000 }
  const ledger = new Map<string, SeenRow>()
  for (const r of opts.ledger || []) ledger.set(r.dropbox_id, { ...r })

  const state = {
    id: 'singleton',
    phase: (opts.state?.phase || 'bootstrap') as 'bootstrap' | 'delta',
    cursor: opts.state?.cursor ?? null,
    lease_holder: null as string | null,
    lease_expires_at: null as string | null,
    fence: 0,
    updated_at: new Date(clock.t).toISOString(),
  }

  const discoveryPages = opts.discoveryPages || []
  const folders = opts.folders || {}
  const channels = opts.channels || {}
  const rpcCalls: Array<{ endpoint: string; body: any }> = []
  const posts: Array<{ channel: string; text: string; blocks: any[] }> = []
  const intakes: any[] = []

  const iso = () => new Date(clock.t).toISOString()

  const rpc = async (endpoint: string, body: any) => {
    rpcCalls.push({ endpoint, body })
    if (endpoint === '/files/list_folder' && body.recursive === true) {
      const pg = discoveryPages[0] || { entries: [], hasMore: false }
      return { entries: pg.entries, cursor: '1', has_more: !!pg.hasMore }
    }
    if (endpoint === '/files/list_folder/continue') {
      const idx = Number(body.cursor)
      const pg = discoveryPages[idx] || { entries: [], hasMore: false }
      return { entries: pg.entries, cursor: String(idx + 1), has_more: !!pg.hasMore }
    }
    if (endpoint === '/files/list_folder' && body.recursive === false) {
      return { entries: folders[body.path] || [], cursor: 'f', has_more: false }
    }
    throw new Error(`unexpected rpc ${endpoint} ${JSON.stringify(body)}`)
  }

  const deps: Partial<SpecsScanDeps> = {
    now: () => clock.t,
    rpc,
    getSeenByIds: async (ids) => {
      const out: Record<string, SeenRow> = {}
      for (const id of ids) if (ledger.has(id)) out[id] = ledger.get(id)!
      return out
    },
    insertFirstSightings: async (rows) => {
      for (const r of rows) {
        if (!ledger.has(r.dropbox_id)) {
          ledger.set(r.dropbox_id, {
            dropbox_id: r.dropbox_id,
            path: r.path,
            size_bytes: r.size_bytes,
            notified_at: null,
            stable_check_count: 1,
          })
        }
      }
    },
    loadPendingSpecs: async () =>
      [...ledger.values()].filter(
        (r) => r.notified_at == null && /^\/production\/\d{4}\/[^/]+\/specs\//i.test(r.path),
      ),
    updateSeen: async (id, patch) => {
      const row = ledger.get(id)
      if (row) Object.assign(row, patch)
    },
    markNotified: async (id) => {
      if (opts.markThrows) throw new Error('simulated ledger write failure')
      const row = ledger.get(id)
      if (row) row.notified_at = iso()
    },
    resolveChannel: async (safeName) => channels[safeName] || null,
    post: async (channel, text, blocks) => {
      posts.push({ channel, text, blocks })
      return opts.postFails ? null : `ts-${posts.length}`
    },
    recordIntake: async (o) => { intakes.push(o) },
    getState: async () => ({ ...state }),
    claimLease: async (holder) => {
      const expired = state.lease_expires_at == null || state.lease_expires_at < iso()
      if (!expired) return { ok: false, fence: null }
      state.fence += 1
      state.lease_holder = holder
      state.lease_expires_at = new Date(clock.t + LEASE_MS).toISOString()
      return { ok: true, fence: state.fence }
    },
    advanceCursor: async (holder, fence, patch) => {
      if (state.lease_holder !== holder || state.fence !== fence) return false
      state.cursor = patch.cursor
      state.phase = patch.phase
      state.lease_expires_at = new Date(clock.t + LEASE_MS).toISOString()
      return true
    },
    releaseLease: async (holder) => {
      if (state.lease_holder === holder) {
        state.lease_holder = null
        state.lease_expires_at = null
      }
    },
    defaultChannel: '',
  }

  return { deps, ledger, state, rpcCalls, posts, intakes, clock }
}

// ─── Pure helpers ───────────────────────────────────────────

describe('pure helpers', () => {
  it('planDiscoveryCall: no cursor → recursive list_folder; cursor → continue', () => {
    const a = planDiscoveryCall(null)
    assert.equal(a.endpoint, '/files/list_folder')
    assert.equal(a.body.recursive, true)
    assert.equal(a.body.path, ROOT)
    const b = planDiscoveryCall('cur9')
    assert.equal(b.endpoint, '/files/list_folder/continue')
    assert.equal(b.body.cursor, 'cur9')
  })

  it('nextPhase: bootstrap completes only when enumeration is exhausted; delta is terminal', () => {
    assert.equal(nextPhase('bootstrap', true), 'bootstrap')
    assert.equal(nextPhase('bootstrap', false), 'delta')
    assert.equal(nextPhase('delta', true), 'delta')
    assert.equal(nextPhase('delta', false), 'delta')
  })

  it('decideStability: same size twice fires; same size once increments; size change resets', () => {
    assert.deepEqual(decideStability({ size_bytes: 100, stable_check_count: 1 }, 100), { action: 'fire' })
    assert.deepEqual(decideStability({ size_bytes: 100, stable_check_count: 0 }, 100), {
      action: 'update',
      patch: { size_bytes: 100, stable_check_count: 1 },
    })
    assert.deepEqual(decideStability({ size_bytes: 100, stable_check_count: 1 }, 150), {
      action: 'update',
      patch: { size_bytes: 150, stable_check_count: 1 },
    })
  })
})

// ─── Discovery: bounded bootstrap, transition, no restart ───

describe('discovery — bootstrap → delta', () => {
  it('bootstrap progresses across invocations, transitions to delta, and never restarts the full tree', async () => {
    // 8 pages; page[7] is the last (has_more=false). Each page adds one file.
    const pages = Array.from({ length: 8 }, (_, i) => ({
      entries: [fileEntry(`id${i}`, `/production/2026/P${i}/specs/video/a.mov`, 10)],
      hasMore: i < 7,
    }))
    const h = makeHarness({ discoveryPages: pages })

    // Tick 1: capped at SCAN_MAX_PAGES (6), still bootstrap.
    const s1 = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s1.pagesFetched, 6)
    assert.equal(s1.phase, 'bootstrap')
    assert.notEqual(s1.bootstrapComplete, true)
    assert.equal(h.state.phase, 'bootstrap')

    // Tick 2: fetches the remaining 2 pages and completes bootstrap → delta.
    const firstCallCountBefore = h.rpcCalls.length
    const s2 = await runSpecsScanTick(h.deps, 'B')
    assert.equal(s2.pagesFetched, 2)
    assert.equal(s2.bootstrapComplete, true)
    assert.equal(s2.phase, 'delta')
    assert.equal(h.state.phase, 'delta')

    // No full-tree restart: tick 2's FIRST discovery call was a continue, not a
    // fresh recursive list_folder.
    const tick2FirstCall = h.rpcCalls[firstCallCountBefore]
    assert.equal(tick2FirstCall.endpoint, '/files/list_folder/continue')
    assert.ok(!h.rpcCalls.slice(firstCallCountBefore).some((c) => c.endpoint === '/files/list_folder' && c.body.recursive === true))

    // All 8 files discovered into the ledger.
    assert.equal(h.ledger.size, 8)
  })

  it('delta mode continues from the persisted cursor (no recursive list_folder)', async () => {
    // Start already in delta at cursor '3'; a single delta page carries one new file.
    const pages: any[] = []
    pages[3] = { entries: [fileEntry('new1', '/production/2026/Q/specs/video/n.mov', 5)], hasMore: false }
    const h = makeHarness({ state: { phase: 'delta', cursor: '3' }, discoveryPages: pages })

    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.phase, 'delta')
    assert.equal(h.ledger.has('new1'), true)
    assert.ok(!h.rpcCalls.some((c) => c.endpoint === '/files/list_folder' && c.body.recursive === true))
  })
})

// ─── Stability gate + firing ────────────────────────────────

describe('stability gate + firing', () => {
  const VPATH = '/production/2026/P/specs/video/a.mov'

  it('a discovered file is not fired the same tick; it fires one tick later when size is stable', async () => {
    const h = makeHarness({
      discoveryPages: [{ entries: [fileEntry('v1', VPATH, 100)], hasMore: false }],
      folders: { [`${ROOT}/2026/P/specs/video`]: [fileEntry('v1', VPATH, 100)], [`${ROOT}/2026/P/specs/audio`]: [] },
      channels: { P: { projectId: 'p1', name: 'Proj', channelId: 'C123' } },
    })

    // Tick 1: discovers v1 (count=1) but does NOT fire (not pending before this tick).
    const s1 = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s1.posted, 0)
    assert.equal(h.posts.length, 0)
    assert.equal(h.ledger.get('v1')!.notified_at, null)
    assert.equal(h.ledger.get('v1')!.stable_check_count, 1)

    // Tick 2: v1 is pending; re-list shows same size → second sighting → fire.
    const s2 = await runSpecsScanTick(h.deps, 'B')
    assert.equal(s2.posted, 1)
    assert.equal(h.posts.length, 1)
    assert.ok(h.ledger.get('v1')!.notified_at)
    assert.equal(h.intakes.length, 1)
  })

  it('a growing file resets the gate instead of firing', async () => {
    const h = makeHarness({
      ledger: [{ dropbox_id: 'v1', path: VPATH, size_bytes: 100, notified_at: null, stable_check_count: 1 }],
      folders: { [`${ROOT}/2026/P/specs/video`]: [fileEntry('v1', VPATH, 150)], [`${ROOT}/2026/P/specs/audio`]: [] },
      channels: { P: { projectId: 'p1', name: 'Proj', channelId: 'C123' } },
    })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.posted, 0)
    assert.equal(h.posts.length, 0)
    assert.equal(h.ledger.get('v1')!.size_bytes, 150)
    assert.equal(h.ledger.get('v1')!.stable_check_count, 1)
  })

  it('a video+audio pair fires exactly one prompt and marks both halves', async () => {
    const VP = '/production/2026/P/specs/video/a.mov'
    const AP = '/production/2026/P/specs/audio/a.wav'
    const h = makeHarness({
      ledger: [
        { dropbox_id: 'v1', path: VP, size_bytes: 10, notified_at: null, stable_check_count: 1 },
        { dropbox_id: 'a1', path: AP, size_bytes: 5, notified_at: null, stable_check_count: 1 },
      ],
      folders: {
        [`${ROOT}/2026/P/specs/video`]: [fileEntry('v1', VP, 10)],
        [`${ROOT}/2026/P/specs/audio`]: [fileEntry('a1', AP, 5)],
      },
      channels: { P: { projectId: 'p1', name: 'Proj', channelId: 'C123' } },
    })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.posted, 1)
    assert.equal(h.posts.length, 1)
    assert.ok(h.ledger.get('v1')!.notified_at)
    assert.ok(h.ledger.get('a1')!.notified_at)
    assert.equal(h.intakes[0].sources.length, 2)
  })

  it('no resolvable channel leaves the file pending (never marked)', async () => {
    const h = makeHarness({
      ledger: [{ dropbox_id: 'v1', path: VPATH, size_bytes: 100, notified_at: null, stable_check_count: 1 }],
      folders: { [`${ROOT}/2026/P/specs/video`]: [fileEntry('v1', VPATH, 100)], [`${ROOT}/2026/P/specs/audio`]: [] },
      channels: {}, // no project match, defaultChannel is ''
    })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.posted, 0)
    assert.equal(h.posts.length, 0)
    assert.equal(h.ledger.get('v1')!.notified_at, null)
  })

  it('caps the fire pass per tick and defers the rest oldest-first (deterministic forward progress)', async () => {
    // 27 projects each with one stable pending drop; the fire-pass cap is 25.
    // loadPendingSpecs yields oldest-first (the real query orders by
    // first_seen_at), so the two NEWEST are deferred and only age toward the
    // front — never starved.
    const N = 27
    const ledger: any[] = []
    const folders: Record<string, any[]> = {}
    const channels: Record<string, { projectId: string; name: string; channelId: string | null }> = {}
    for (let i = 0; i < N; i++) {
      const safe = `P${String(i).padStart(2, '0')}`
      const vp = `/production/2026/${safe}/specs/video/a.mov`
      ledger.push({ dropbox_id: `v${i}`, path: vp, size_bytes: 10, notified_at: null, stable_check_count: 1 })
      folders[`${ROOT}/2026/${safe}/specs/video`] = [fileEntry(`v${i}`, vp, 10)]
      folders[`${ROOT}/2026/${safe}/specs/audio`] = []
      channels[safe] = { projectId: `p${i}`, name: safe, channelId: `C${i}` }
    }
    const h = makeHarness({ ledger, folders, channels })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.projectsChecked, 25)
    assert.equal(s.deferredProjects, 2)
    assert.equal(s.posted, 25)
    // Oldest 25 fired; the two newest were deferred and remain pending.
    assert.ok(h.ledger.get('v0')!.notified_at)
    assert.ok(h.ledger.get('v24')!.notified_at)
    assert.equal(h.ledger.get('v25')!.notified_at, null)
    assert.equal(h.ledger.get('v26')!.notified_at, null)
  })
})

// ─── Idempotency contract ───────────────────────────────────

describe('idempotency — post-then-mark', () => {
  const VPATH = '/production/2026/P/specs/video/a.mov'
  const stableLedger = () => [
    { dropbox_id: 'v1', path: VPATH, size_bytes: 100, notified_at: null as string | null, stable_check_count: 1 },
  ]
  const folders = { [`${ROOT}/2026/P/specs/video`]: [fileEntry('v1', VPATH, 100)], [`${ROOT}/2026/P/specs/audio`]: [] }
  const channels = { P: { projectId: 'p1', name: 'Proj', channelId: 'C123' } }

  it('a Slack failure leaves the file pending and it re-posts next tick (no lost delivery)', async () => {
    // Tick 1: post fails → not marked.
    const h1 = makeHarness({ ledger: stableLedger(), folders, channels, postFails: true })
    const s1 = await runSpecsScanTick(h1.deps, 'A')
    assert.equal(s1.posted, 0)
    assert.equal(h1.posts.length, 1) // attempted
    assert.equal(h1.ledger.get('v1')!.notified_at, null) // still pending

    // Tick 2 (fresh harness = same ledger state) with Slack recovered → delivered.
    const h2 = makeHarness({ ledger: stableLedger(), folders, channels, postFails: false })
    const s2 = await runSpecsScanTick(h2.deps, 'B')
    assert.equal(s2.posted, 1)
    assert.ok(h2.ledger.get('v1')!.notified_at)
  })

  it('a mark failure AFTER a successful post degrades to an at-least-once duplicate, never a loss', async () => {
    const h = makeHarness({ ledger: stableLedger(), folders, channels, markThrows: true })
    // The post succeeds (delivered) even though the mark write fails; the tick
    // must not throw, and the row stays pending (→ recoverable duplicate later).
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.posted, 1)
    assert.equal(h.posts.length, 1)
    assert.equal(h.ledger.get('v1')!.notified_at, null)
  })
})

// ─── Lease behavior through the orchestrator ────────────────

describe('lease behavior', () => {
  it('a contending run exits successfully as skipped without touching the cursor', async () => {
    const h = makeHarness({ discoveryPages: [{ entries: [fileEntry('v1', '/production/2026/P/specs/video/a.mov', 1)], hasMore: false }] })
    // Simulate an active lease held by another run.
    h.state.lease_holder = 'other'
    h.state.lease_expires_at = new Date(h.clock.t + LEASE_MS).toISOString()

    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.skipped, 'locked')
    assert.equal(h.posts.length, 0)
    assert.equal(h.ledger.size, 0) // nothing discovered
    assert.equal(h.state.lease_holder, 'other') // untouched
  })

  it('an expired lease is reclaimed and the tick runs and releases', async () => {
    const h = makeHarness({ discoveryPages: [{ entries: [fileEntry('v1', '/production/2026/P/specs/video/a.mov', 1)], hasMore: false }] })
    h.state.lease_holder = 'crashed'
    h.state.lease_expires_at = new Date(h.clock.t - 1000).toISOString() // expired

    const s = await runSpecsScanTick(h.deps, 'A')
    assert.notEqual(s.skipped, 'locked')
    assert.equal(h.ledger.size, 1) // discovered
    assert.equal(h.state.lease_holder, null) // released at end
  })

  it('losing the lease mid-tick stops before firing', async () => {
    const h = makeHarness({
      discoveryPages: [{ entries: [fileEntry('v1', '/production/2026/P/specs/video/a.mov', 1)], hasMore: false }],
    })
    // Override advanceCursor to simulate the lease being reclaimed by a newer holder.
    h.deps.advanceCursor = async () => false

    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.skipped, 'lease_lost')
    assert.equal(h.posts.length, 0)
  })
})
