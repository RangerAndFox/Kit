/**
 * Frame.io 'rename' action: reconciles by the Kit marker and treats 0 / ≥2
 * matches as PERMANENT (terminal) — never renames by business name, never guesses
 * among duplicates. New rows use the persisted provider id; legacy rows fall back
 * to the marker once. Every successful rename leaves a clean business name.
 *
 * Uses the static-token auth fallback (FRAMEIO_TOKEN, no Adobe creds) so
 * frameioHeaders makes no DB/network call, and mocks globalThis.fetch for the
 * project list + PATCH.
 *
 * Run: npx tsx --test src/lib/inngest/agents/frameio.rename.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { frameioAgent, frameioKitMarker, stripFrameioKitMarker } from './frameio'

const origFetch = globalThis.fetch
const KIT = 'kit-uuid-123'
const MARKER = frameioKitMarker(KIT)

beforeEach(() => {
  delete process.env.FRAMEIO_ADOBE_CLIENT_ID
  delete process.env.FRAMEIO_ADOBE_CLIENT_SECRET
  delete process.env.FRAMEIO_ADOBE_REFRESH_TOKEN
  process.env.FRAMEIO_TOKEN = 'static-test-token'
  process.env.FRAMEIO_ACCOUNT_ID = 'ACC'
  process.env.FRAMEIO_WORKSPACE_ID = 'WKS'
})
afterEach(() => {
  globalThis.fetch = origFetch
})

/** Route GET (project list) vs PATCH (rename) to handlers. */
function frameMock(opts: { list: any[]; onPatch?: (body: any, url: string) => any }) {
  const calls: Array<{ method: string; url: string; body: any }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method, url: String(url), body })
    if (method === 'PATCH') {
      const data = opts.onPatch ? opts.onPatch(body, String(url)) : { data: { id: 'p1', name: body?.data?.name } }
      return { ok: true, json: async () => data }
    }
    // GET → single page project list, no next link.
    return { ok: true, json: async () => ({ data: opts.list }) }
  }) as any
  return calls
}

describe("frameio 'rename'", () => {
  it('PATCHes the one legacy marker-matched project and removes the marker', async () => {
    const calls = frameMock({ list: [
      { id: 'other', name: 'unrelated' },
      { id: 'p1', name: `2601_Nike_Old ${MARKER}` },
    ] })
    const res: any = await frameioAgent.handler('rename', { projectId: KIT, projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign' })
    assert.equal(res.success, true)
    assert.equal(res.id, 'p1')
    const patch = calls.find((c) => c.method === 'PATCH')!
    assert.ok(patch, 'a PATCH was issued')
    assert.ok(patch.url.endsWith('/accounts/ACC/projects/p1'))
    assert.equal(patch.body.data.name, '2601_Adidas_Summer Campaign')
  })

  it('is terminal with no PATCH when no project carries the marker', async () => {
    const calls = frameMock({ list: [{ id: 'x', name: 'no marker' }] })
    const res: any = await frameioAgent.handler('rename', { projectId: KIT, projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign' })
    assert.equal(res.success, false)
    assert.equal(res.terminal, true)
    assert.equal(calls.some((c) => c.method === 'PATCH'), false)
  })

  it('is terminal with no PATCH when the marker is ambiguous (≥2 matches)', async () => {
    const calls = frameMock({ list: [
      { id: 'a', name: `dup ${MARKER}` },
      { id: 'b', name: `dup ${MARKER}` },
    ] })
    const res: any = await frameioAgent.handler('rename', { projectId: KIT, projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign' })
    assert.equal(res.success, false)
    assert.equal(res.terminal, true)
    assert.equal(calls.some((c) => c.method === 'PATCH'), false)
  })

  it('is terminal when no Kit project id is provided', async () => {
    frameMock({ list: [] })
    const res: any = await frameioAgent.handler('rename', { projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign' })
    assert.equal(res.success, false)
    assert.equal(res.terminal, true)
  })

  it('uses an exact persisted Frame.io id and keeps the new name clean', async () => {
    const calls: Array<{ method: string; url: string; body: any }> = []
    globalThis.fetch = (async (url: any, init: any) => {
      const method = init?.method || 'GET'
      const body = init?.body ? JSON.parse(init.body) : undefined
      calls.push({ method, url: String(url), body })
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ data: { id: 'p1', name: '2601_Nike_Old' } }) }
      return { ok: true, status: 200, json: async () => ({ data: { id: 'p1', name: body.data.name } }) }
    }) as any
    const res: any = await frameioAgent.handler('rename', {
      projectId: KIT, frameioProjectId: 'p1', projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign',
    })
    assert.equal(res.success, true)
    assert.equal(calls.filter((c) => c.method === 'GET').length, 1)
    assert.equal(calls.find((c) => c.method === 'PATCH')?.body.data.name, '2601_Adidas_Summer Campaign')
  })

  it('finalizes a transient create marker by exact id and is idempotent', async () => {
    let currentName = `2601_Nike_Summer Campaign ${MARKER}`
    let patchCount = 0
    globalThis.fetch = (async (_url: any, init: any) => {
      if ((init?.method || 'GET') === 'PATCH') {
        patchCount++
        currentName = JSON.parse(init.body).data.name
        return { ok: true, status: 200, json: async () => ({ data: { id: 'p1', name: currentName } }) }
      }
      return { ok: true, status: 200, json: async () => ({ data: { id: 'p1', name: currentName } }) }
    }) as any
    const payload = { projectId: KIT, frameioProjectId: 'p1', projectNumber: '2601', client: 'Nike', projectName: 'Summer Campaign' }
    assert.equal((await frameioAgent.handler('finalize_name', payload)).success, true)
    assert.equal((await frameioAgent.handler('finalize_name', payload)).success, true)
    assert.equal(currentName, '2601_Nike_Summer Campaign')
    assert.equal(patchCount, 1)
  })

  it('refuses to finalize a project carrying another Kit project marker', async () => {
    const calls = frameMock({ list: [] })
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ method: init?.method || 'GET', url: String(url), body: init?.body })
      return { ok: true, status: 200, json: async () => ({ data: { id: 'p1', name: '2601_Nike_X [kit:someone-else]' } }) }
    }) as any
    const res: any = await frameioAgent.handler('finalize_name', {
      projectId: KIT, frameioProjectId: 'p1', projectNumber: '2601', client: 'Nike', projectName: 'X',
    })
    assert.equal(res.success, false)
    assert.equal(res.terminal, true)
    assert.equal(calls.some((c) => c.method === 'PATCH'), false)
  })

  it('strips only a trailing Kit marker', () => {
    assert.equal(stripFrameioKitMarker(`2601_Nike_X ${MARKER}`), '2601_Nike_X')
    assert.equal(stripFrameioKitMarker('2601_[kit:reference]_X'), '2601_[kit:reference]_X')
  })
})
