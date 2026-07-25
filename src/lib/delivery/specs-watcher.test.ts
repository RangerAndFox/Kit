/**
 * Bounded specs-scan orchestrator tests. `runSpecsScanTick` takes injectable
 * dependencies, so these drive it with in-memory fakes (no DB, no Dropbox, no
 * Slack) and assert the durable behavior of the two-path model: one-time live-
 * cursor seeding (get_latest_cursor, no recursive enumeration), delta polling,
 * non-recursive backlog traversal over a persisted frontier, convergence/
 * idempotency between the two paths, plus the preserved two-sighting gate,
 * dedup/pairing, post-then-mark, eviction, and lease/fence behavior.
 *
 * Run: npx tsx --test src/lib/delivery/specs-watcher.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runSpecsScanTick,
  decideStability,
  specsFrontierChildren,
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
function folderEntry(path: string) {
  const name = path.split('/').pop()!
  return { '.tag': 'folder', id: `fld:${path}`, name, path_display: path, path_lower: path.toLowerCase() }
}

interface HarnessOpts {
  ledger?: SeenRow[]
  /** Non-recursive list_folder responses: path -> entries (files + folders). Absent path => Dropbox not_found. */
  folders?: Record<string, any[]>
  /** list_folder/continue responses keyed by incoming cursor. */
  deltaResponses?: Record<string, { entries: any[]; cursor: string; has_more: boolean }>
  latestCursor?: string
  channels?: Record<string, { projectId: string; name: string; channelId: string | null }>
  state?: Partial<{ cursor: string | null; backlog_complete: boolean }>
  frontier?: string[]
  postFails?: boolean
  markThrows?: boolean
}

function makeHarness(opts: HarnessOpts = {}) {
  const clock = { t: 1_000_000 }
  const ledger = new Map<string, SeenRow>()
  for (const r of opts.ledger || []) ledger.set(r.dropbox_id, { ...r })

  // Default: SEEDED (cursor set) + backlog complete, so fire/stability/eviction
  // tests exercise the fire pass without seeding or backlog side-effects.
  const state = {
    id: 'singleton',
    phase: 'delta' as 'bootstrap' | 'delta',
    cursor: opts.state?.cursor === undefined ? 'seeded-cursor' : opts.state.cursor,
    lease_holder: null as string | null,
    lease_expires_at: null as string | null,
    fence: 0,
    backlog_complete: opts.state?.backlog_complete ?? true,
    updated_at: new Date(clock.t).toISOString(),
  }

  const folders = opts.folders || {}
  const deltaResponses = opts.deltaResponses || {}
  const channels = opts.channels || {}
  const frontier: string[] = [...(opts.frontier || [])]
  const frontierSet = new Set(frontier)
  const rpcCalls: Array<{ endpoint: string; body: any }> = []
  const posts: Array<{ channel: string; text: string; blocks: any[] }> = []
  const intakes: any[] = []
  const iso = () => new Date(clock.t).toISOString()

  const rpc = async (endpoint: string, body: any) => {
    rpcCalls.push({ endpoint, body })
    if (endpoint === '/files/list_folder/get_latest_cursor') {
      return { cursor: opts.latestCursor || 'live-cursor' }
    }
    if (endpoint === '/files/list_folder/continue') {
      const r = deltaResponses[body.cursor]
      return r || { entries: [], cursor: body.cursor, has_more: false }
    }
    if (endpoint === '/files/list_folder' && body.recursive === false) {
      const entries = folders[body.path]
      if (entries === undefined) throw new Error(`Dropbox /files/list_folder 409: {"error_summary":"path/not_found/.."}`)
      return { entries, cursor: `f:${body.path}`, has_more: false }
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
            dropbox_id: r.dropbox_id, path: r.path, size_bytes: r.size_bytes,
            notified_at: null, stable_check_count: 1,
          })
        }
      }
    },
    loadPendingSpecs: async () =>
      [...ledger.values()].filter(
        (r) => r.notified_at == null && /^\/production\/\d{4}\/[^/]+\/specs\//i.test(r.path),
      ),
    updateSeen: async (id, patch) => { const row = ledger.get(id); if (row) Object.assign(row, patch) },
    evictSeen: async (id) => { ledger.delete(id) },
    markNotified: async (id) => {
      if (opts.markThrows) throw new Error('simulated ledger write failure')
      const row = ledger.get(id); if (row) row.notified_at = iso()
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
      state.fence += 1; state.lease_holder = holder
      state.lease_expires_at = new Date(clock.t + LEASE_MS).toISOString()
      return { ok: true, fence: state.fence }
    },
    advanceCursor: async (holder, fence, patch) => {
      if (state.lease_holder !== holder || state.fence !== fence) return false
      state.cursor = patch.cursor; state.phase = patch.phase
      state.lease_expires_at = new Date(clock.t + LEASE_MS).toISOString()
      return true
    },
    releaseLease: async (holder) => {
      if (state.lease_holder === holder) { state.lease_holder = null; state.lease_expires_at = null }
    },
    enqueueFrontier: async (paths) => {
      for (const p of paths) if (!frontierSet.has(p)) { frontierSet.add(p); frontier.push(p) }
    },
    loadFrontierBatch: async (limit) => frontier.slice(0, limit),
    // Atomic ownership-conditional checkpoint (mirrors migration-061 RPCs): all
    // frontier mutations happen only when the holder+fence still own the lease.
    commitBacklogFolder: async (holder, fence, parent, children) => {
      if (state.lease_holder !== holder || state.fence !== fence) return false
      for (const c of children) if (!frontierSet.has(c)) { frontierSet.add(c); frontier.push(c) }
      const i = frontier.indexOf(parent); if (i >= 0) frontier.splice(i, 1); frontierSet.delete(parent)
      return true
    },
    markBacklogCompleteIfEmpty: async (holder, fence) => {
      if (state.lease_holder !== holder || state.fence !== fence) return false
      if (frontier.length > 0) return false
      state.backlog_complete = true; return true
    },
    defaultChannel: '',
  }

  return { deps, ledger, state, rpcCalls, posts, intakes, frontier, clock }
}

// ─── Pure helpers ───────────────────────────────────────────

describe('pure helpers', () => {
  it('decideStability: same size twice fires; same size once increments; size change resets', () => {
    assert.deepEqual(decideStability({ size_bytes: 100, stable_check_count: 1 }, 100), { action: 'fire' })
    assert.deepEqual(decideStability({ size_bytes: 100, stable_check_count: 0 }, 100), {
      action: 'update', patch: { size_bytes: 100, stable_check_count: 1 },
    })
    assert.deepEqual(decideStability({ size_bytes: 100, stable_check_count: 1 }, 150), {
      action: 'update', patch: { size_bytes: 150, stable_check_count: 1 },
    })
  })

  it('specsFrontierChildren prunes each level to the specs subtree', () => {
    assert.deepEqual(
      specsFrontierChildren('/production', ['/production/2026', '/production/archive', '/production/2025']),
      ['/production/2026', '/production/2025'], // only 4-digit years
    )
    assert.deepEqual(
      specsFrontierChildren('/production/2026', ['/production/2026/A', '/production/2026/B']),
      ['/production/2026/A', '/production/2026/B'], // all projects
    )
    assert.deepEqual(
      specsFrontierChildren('/production/2026/P', ['/production/2026/P/specs', '/production/2026/P/08_AE']),
      ['/production/2026/P/specs'], // only specs
    )
    assert.deepEqual(
      specsFrontierChildren('/production/2026/P/specs', ['/production/2026/P/specs/video', '/production/2026/P/specs/junk']),
      ['/production/2026/P/specs/video'], // only video/audio
    )
    assert.deepEqual(
      specsFrontierChildren('/production/2026/P/specs/video', ['/production/2026/P/specs/video/nested']),
      [], // leaf — specs files are direct children, nothing deeper
    )
  })
})

// ─── Seeding (one-time upgrade from cursor=null) ────────────

describe('seed live coverage', () => {
  it('seeds via get_latest_cursor with no recursive enumeration, enqueues the backlog root, and returns', async () => {
    const h = makeHarness({ state: { cursor: null, backlog_complete: false }, latestCursor: 'C0' })
    const s = await runSpecsScanTick(h.deps, 'A')

    assert.equal(s.seeded, true)
    assert.equal(h.state.cursor, 'C0') // live cursor persisted
    assert.equal(h.state.phase, 'delta')
    assert.ok(h.frontier.includes(ROOT)) // backlog root enqueued
    // No recursive enumeration anywhere.
    assert.ok(!h.rpcCalls.some((c) => c.endpoint === '/files/list_folder' && c.body.recursive === true))
    assert.ok(h.rpcCalls.some((c) => c.endpoint === '/files/list_folder/get_latest_cursor'))
    assert.equal(h.posts.length, 0) // establishes coverage only
    assert.equal(h.state.lease_holder, null) // released
  })

  it('a lost lease during seed does not persist the cursor', async () => {
    const h = makeHarness({ state: { cursor: null, backlog_complete: false } })
    h.deps.advanceCursor = async () => false
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.skipped, 'lease_lost')
    assert.equal(h.state.cursor, null)
  })
})

// ─── Live delta ─────────────────────────────────────────────

describe('live delta', () => {
  it('processes a delta page while the backlog is still incomplete; never enumerates recursively', async () => {
    const VP = '/production/2026/Q/specs/video/n.mov'
    const h = makeHarness({
      state: { cursor: 'c0', backlog_complete: false },
      deltaResponses: { c0: { entries: [fileEntry('n1', VP, 5)], cursor: 'c1', has_more: false } },
      frontier: [ROOT],
      folders: { [ROOT]: [] }, // backlog visits root, finds nothing new this tick
    })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(h.ledger.has('n1'), true) // delta discovered the new file
    assert.equal(h.state.cursor, 'c1') // cursor advanced
    assert.equal(s.phase, 'delta')
    assert.ok(!h.rpcCalls.some((c) => c.endpoint === '/files/list_folder' && c.body.recursive === true))
  })
})

// ─── Historical backlog traversal ───────────────────────────

describe('historical backlog', () => {
  const treeFolders = () => ({
    [ROOT]: [folderEntry('/production/2026')],
    '/production/2026': [folderEntry('/production/2026/P')],
    '/production/2026/P': [folderEntry('/production/2026/P/specs'), folderEntry('/production/2026/P/08_AE')],
    '/production/2026/P/specs': [folderEntry('/production/2026/P/specs/video'), folderEntry('/production/2026/P/specs/audio')],
    '/production/2026/P/specs/video': [fileEntry('deep1', '/production/2026/P/specs/video/a.mov', 10)],
    '/production/2026/P/specs/audio': [],
  })

  it('advances breadth-first across invocations, visits nested folders, prunes non-specs branches, and discovers the deep file', async () => {
    const folders = treeFolders()
    const h = makeHarness({ state: { cursor: 'seeded', backlog_complete: false }, frontier: [ROOT], folders })

    // Drive several ticks; each visits one BFS generation.
    let completed = false
    for (let i = 0; i < 8 && !completed; i++) {
      const s = await runSpecsScanTick(h.deps, `run-${i}`)
      if (s.backlogComplete) completed = true
    }
    assert.equal(completed, true) // reached completion
    assert.equal(h.state.backlog_complete, true)
    assert.equal(h.ledger.has('deep1'), true) // deep specs file discovered
    // The non-specs branch was pruned (never listed).
    assert.ok(!h.rpcCalls.some((c) => c.body?.path === '/production/2026/P/08_AE'))
    // Frontier fully drained.
    assert.equal(h.frontier.length, 0)
  })

  it('resumes from the persisted frontier (a fresh run continues mid-traversal)', async () => {
    const folders = treeFolders()
    // Frontier persisted mid-traversal at the project level.
    const h = makeHarness({
      state: { cursor: 'seeded', backlog_complete: false },
      frontier: ['/production/2026/P'],
      folders,
    })
    const s = await runSpecsScanTick(h.deps, 'resume')
    // Visited the project, pruned to specs, enqueued it — did NOT restart at root.
    assert.ok(h.rpcCalls.some((c) => c.body?.path === '/production/2026/P'))
    assert.ok(!h.rpcCalls.some((c) => c.body?.path === ROOT))
    assert.ok(h.frontier.includes('/production/2026/P/specs'))
    assert.equal(s.backlogFoldersVisited, 1)
  })

  it('a completed backlog never restarts and never re-lists', async () => {
    const h = makeHarness({ state: { cursor: 'seeded', backlog_complete: true }, frontier: [], folders: { [ROOT]: [] } })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.backlogFoldersVisited, 0)
    assert.ok(!h.rpcCalls.some((c) => c.body?.path === ROOT)) // no backlog listing at all
  })

  it('a rejected (stale) atomic commit stops the backlog and leaves the frontier untouched', async () => {
    const h = makeHarness({
      state: { cursor: 'seeded', backlog_complete: false },
      frontier: [ROOT],
      folders: { [ROOT]: [folderEntry('/production/2026')] },
    })
    // The atomic RPC rejects a stale owner: no enqueue, no delete.
    h.deps.commitBacklogFolder = async () => false
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.skipped, 'lease_lost')
    assert.deepEqual(h.frontier, [ROOT]) // untouched — no partial mutation
  })
})

// ─── Convergence / idempotency between delta and backlog ────

describe('convergence', () => {
  it('the same file discovered by BOTH delta and backlog yields one ledger row (id-keyed, idempotent)', async () => {
    const VP = '/production/2026/P/specs/video/a.mov'
    const h = makeHarness({
      state: { cursor: 'c0', backlog_complete: false },
      deltaResponses: { c0: { entries: [fileEntry('dup1', VP, 10)], cursor: 'c1', has_more: false } },
      frontier: [VP.replace(/\/[^/]+$/, '')], // frontier positioned at the video folder
      folders: { '/production/2026/P/specs/video': [fileEntry('dup1', VP, 10)] },
    })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(h.ledger.size, 1)
    assert.equal(h.ledger.has('dup1'), true)
    assert.equal(s.discovered, 1) // counted fresh exactly once
  })
})

// ─── Stability gate + firing (preserved) ────────────────────

describe('stability gate + firing', () => {
  const VPATH = '/production/2026/P/specs/video/a.mov'

  it('a video+audio pair fires exactly one prompt and marks both halves', async () => {
    const VP = '/production/2026/P/specs/video/a.mov'
    const AP = '/production/2026/P/specs/audio/a.wav'
    const h = makeHarness({
      ledger: [
        { dropbox_id: 'v1', path: VP, size_bytes: 10, notified_at: null, stable_check_count: 1 },
        { dropbox_id: 'a1', path: AP, size_bytes: 5, notified_at: null, stable_check_count: 1 },
      ],
      folders: {
        '/production/2026/P/specs/video': [fileEntry('v1', VP, 10)],
        '/production/2026/P/specs/audio': [fileEntry('a1', AP, 5)],
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

  it('a growing file resets the gate instead of firing', async () => {
    const h = makeHarness({
      ledger: [{ dropbox_id: 'v1', path: VPATH, size_bytes: 100, notified_at: null, stable_check_count: 1 }],
      folders: { '/production/2026/P/specs/video': [fileEntry('v1', VPATH, 150)], '/production/2026/P/specs/audio': [] },
      channels: { P: { projectId: 'p1', name: 'Proj', channelId: 'C123' } },
    })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.posted, 0)
    assert.equal(h.ledger.get('v1')!.stable_check_count, 1)
    assert.equal(h.ledger.get('v1')!.size_bytes, 150)
  })

  it('no resolvable channel leaves the file pending (never marked)', async () => {
    const h = makeHarness({
      ledger: [{ dropbox_id: 'v1', path: VPATH, size_bytes: 100, notified_at: null, stable_check_count: 1 }],
      folders: { '/production/2026/P/specs/video': [fileEntry('v1', VPATH, 100)], '/production/2026/P/specs/audio': [] },
      channels: {},
    })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.posted, 0)
    assert.equal(h.ledger.get('v1')!.notified_at, null)
  })

  it('evicts a pending file that has vanished from a successfully-listed folder', async () => {
    const h = makeHarness({
      ledger: [{ dropbox_id: 'v1', path: VPATH, size_bytes: 100, notified_at: null, stable_check_count: 1 }],
      folders: { '/production/2026/P/specs/video': [], '/production/2026/P/specs/audio': [] },
      channels: { P: { projectId: 'p1', name: 'Proj', channelId: 'C123' } },
    })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.evicted, 1)
    assert.equal(h.ledger.has('v1'), false)
  })

  it('caps the fire pass per tick and defers the rest oldest-first', async () => {
    const N = 27
    const ledger: any[] = []
    const folders: Record<string, any[]> = {}
    const channels: Record<string, any> = {}
    for (let i = 0; i < N; i++) {
      const safe = `P${String(i).padStart(2, '0')}`
      const vp = `/production/2026/${safe}/specs/video/a.mov`
      ledger.push({ dropbox_id: `v${i}`, path: vp, size_bytes: 10, notified_at: null, stable_check_count: 1 })
      folders[`/production/2026/${safe}/specs/video`] = [fileEntry(`v${i}`, vp, 10)]
      folders[`/production/2026/${safe}/specs/audio`] = []
      channels[safe] = { projectId: `p${i}`, name: safe, channelId: `C${i}` }
    }
    const h = makeHarness({ ledger, folders, channels })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.projectsChecked, 25)
    assert.equal(s.deferredProjects, 2)
    assert.equal(s.posted, 25)
    assert.equal(h.ledger.get('v25')!.notified_at, null)
    assert.equal(h.ledger.get('v26')!.notified_at, null)
  })

  it('partial backlog traversal does not evict a pending file', async () => {
    const VP = '/production/2026/P/specs/video/a.mov'
    const h = makeHarness({
      state: { cursor: 'seeded', backlog_complete: false },
      ledger: [{ dropbox_id: 'v1', path: VP, size_bytes: 100, notified_at: null, stable_check_count: 1 }],
      // Fire pass sees the file present (no eviction); no channel so it just waits.
      folders: { '/production/2026/P/specs/video': [fileEntry('v1', VP, 100)], '/production/2026/P/specs/audio': [], [ROOT]: [] },
      frontier: [ROOT], // backlog visits root, which does not contain the file
      channels: {},
    })
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.evicted, 0) // backlog never evicts
    assert.equal(h.ledger.has('v1'), true) // survives partial traversal
  })
})

// ─── Idempotency contract (preserved) ───────────────────────

describe('idempotency — post-then-mark', () => {
  const VPATH = '/production/2026/P/specs/video/a.mov'
  const stableLedger = () => [
    { dropbox_id: 'v1', path: VPATH, size_bytes: 100, notified_at: null as string | null, stable_check_count: 1 },
  ]
  const folders = { '/production/2026/P/specs/video': [fileEntry('v1', VPATH, 100)], '/production/2026/P/specs/audio': [] }
  const channels = { P: { projectId: 'p1', name: 'Proj', channelId: 'C123' } }

  it('a Slack failure leaves the file pending; a mark failure after a post degrades to at-least-once, never loss', async () => {
    const h1 = makeHarness({ ledger: stableLedger(), folders, channels, postFails: true })
    const s1 = await runSpecsScanTick(h1.deps, 'A')
    assert.equal(s1.posted, 0)
    assert.equal(h1.ledger.get('v1')!.notified_at, null) // pending → retried

    const h2 = makeHarness({ ledger: stableLedger(), folders, channels, markThrows: true })
    const s2 = await runSpecsScanTick(h2.deps, 'B')
    assert.equal(s2.posted, 1) // delivered
    assert.equal(h2.ledger.get('v1')!.notified_at, null) // mark failed → recoverable duplicate, not a loss
  })
})

// ─── Lease behavior (preserved) ─────────────────────────────

describe('lease behavior', () => {
  it('a contending run exits skipped without touching state', async () => {
    const h = makeHarness({ state: { cursor: null, backlog_complete: false } })
    h.state.lease_holder = 'other'
    h.state.lease_expires_at = new Date(h.clock.t + LEASE_MS).toISOString()
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.equal(s.skipped, 'locked')
    assert.equal(h.state.cursor, null) // untouched
    assert.equal(h.state.lease_holder, 'other')
  })

  it('an expired lease is reclaimed and the tick runs and releases', async () => {
    const h = makeHarness({})
    h.state.lease_holder = 'crashed'
    h.state.lease_expires_at = new Date(h.clock.t - 1000).toISOString()
    const s = await runSpecsScanTick(h.deps, 'A')
    assert.notEqual(s.skipped, 'locked')
    assert.equal(h.state.lease_holder, null) // released
  })
})
