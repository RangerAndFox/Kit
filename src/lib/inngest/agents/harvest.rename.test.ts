/**
 * Harvest 'rename' action reconciliation:
 *  - reconcile-by-Kit-marker when the project was Kit-created (marker in notes);
 *  - FALL BACK to the numeric harvest_project_id when the marker search finds
 *    nothing — the /kit sync-projects case, where sync links the FK but never
 *    writes the marker into Harvest notes;
 *  - terminal on a marker COLLISION (2+ share it).
 *
 * Static-token auth (HARVEST_ACCESS_TOKEN) so headers() makes no network call.
 *
 * Run: npx tsx --test src/lib/inngest/agents/harvest.rename.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { harvestAgent } from './harvest'
import { kitProjectMarker } from '@/lib/harvest/client'

const origFetch = globalThis.fetch

beforeEach(() => {
  process.env.HARVEST_ACCESS_TOKEN = 'tok'
  process.env.HARVEST_ACCOUNT_ID = 'acct'
})
afterEach(() => {
  globalThis.fetch = origFetch
})

/** Route Harvest calls: list (GET /projects), get-by-id (GET /projects/{id}),
 *  rename (PATCH /projects/{id}). `list` is what the marker scan sees. */
function harvestMock(opts: { list: any[]; byId?: Record<string, any>; onPatch?: (id: string, body: any) => any }) {
  const calls: Array<{ method: string; url: string; body: any }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url)
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method, url: u, body })
    const byIdMatch = u.match(/\/projects\/(\d+)/)
    if (byIdMatch) {
      const id = byIdMatch[1]
      if (method === 'PATCH') {
        const patched = opts.onPatch ? opts.onPatch(id, body) : { id: Number(id), ...body }
        return { ok: true, json: async () => patched }
      }
      const row = opts.byId?.[id]
      if (!row) return { ok: false, status: 404, text: async () => 'not_found' }
      return { ok: true, json: async () => row }
    }
    // list endpoint (single page)
    return { ok: true, json: async () => ({ projects: opts.list, next_page: null }) }
  }) as any
  return calls
}

describe("harvest 'rename' reconciliation", () => {
  it('falls back to harvest_project_id when there is NO Kit marker (sync-linked project)', async () => {
    // The list carries no marker for KP1 → reconcile-by-marker finds nothing.
    const calls = harvestMock({
      list: [{ id: 555, name: 'Old Name', code: '2601-Nike', is_active: true, notes: 'internal — no kit marker', client: { id: 1, name: 'Nike' } }],
      byId: { '555': { id: 555, name: 'Old Name', code: '2601-Nike', is_active: true, notes: '', client: { id: 1, name: 'Nike' } } },
      onPatch: (id, b) => ({ id: Number(id), name: b.name ?? 'Old Name', code: b.code ?? '2601-Nike', is_active: true, client: { id: 1, name: 'Nike' } }),
    })
    const res: any = await harvestAgent.handler('rename', {
      projectId: 'KP1', harvestProjectId: 555, projectName: 'New Name', projectCode: '2601-Nike', client: 'Nike',
    })
    assert.equal(res.success, true)
    assert.equal(res.id, '555')
    // It resolved via GET /projects/555 and PATCHed that id.
    assert.ok(calls.some((c) => c.method === 'GET' && /\/projects\/555/.test(c.url)))
    const patch = calls.find((c) => c.method === 'PATCH')!
    assert.match(patch.url, /\/projects\/555/)
    assert.equal(patch.body.name, 'New Name')
  })

  it('does NOT wedge terminal on a TRANSIENT get-by-id error (retryable, not false-gone)', async () => {
    // No marker → fall back to getHarvestProjectById(555), which hits a 500. That
    // must NOT be read as "project gone" (terminal); it's a retryable failure.
    harvestMock({
      list: [],
      // byId omitted → but override with a 500 for /projects/555:
      byId: {},
    })
    // Re-point the byId GET to a 500 explicitly.
    const orig = globalThis.fetch
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url)
      if (/\/projects\/555/.test(u)) return { ok: false, status: 500, text: async () => 'internal_error' }
      return orig(url, init)
    }) as any
    const res: any = await harvestAgent.handler('rename', {
      projectId: 'KP1', harvestProjectId: 555, projectName: 'New Name',
    })
    assert.equal(res.success, false)
    assert.notEqual(res.terminal, true) // transient → retryable, not terminal
  })

  it('is terminal when there is no marker AND no harvest_project_id to fall back to', async () => {
    harvestMock({ list: [] })
    const res: any = await harvestAgent.handler('rename', {
      projectId: 'KP1', projectName: 'New Name', projectCode: '2601-Nike',
    })
    assert.equal(res.success, false)
    assert.equal(res.terminal, true)
  })

  it('is terminal on a marker COLLISION (2+ projects share it), never guessing', async () => {
    const marker = kitProjectMarker('KP1')
    harvestMock({
      list: [
        { id: 100, name: 'A', code: 'c', is_active: true, notes: `x ${marker}`, client: { id: 1, name: 'Nike' } },
        { id: 101, name: 'B', code: 'c2', is_active: true, notes: `y ${marker}`, client: { id: 1, name: 'Nike' } },
      ],
    })
    const res: any = await harvestAgent.handler('rename', {
      projectId: 'KP1', harvestProjectId: 100, projectName: 'New Name',
    })
    assert.equal(res.success, false)
    assert.equal(res.terminal, true)
    assert.match(res.error, /ambiguous_harvest_projects/)
  })
})
