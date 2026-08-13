/**
 * Frame.io 'rename' action: reconciles by the Kit marker and treats 0 / ≥2
 * matches as PERMANENT (terminal) — never renames by business name, never guesses
 * among duplicates. On exactly one match it PATCHes the project name, preserving
 * the marker.
 *
 * Uses the static-token auth fallback (FRAMEIO_TOKEN, no Adobe creds) so
 * frameioHeaders makes no DB/network call, and mocks globalThis.fetch for the
 * project list + PATCH.
 *
 * Run: npx tsx --test src/lib/inngest/agents/frameio.rename.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { frameioAgent, frameioKitMarker } from './frameio'

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
  it('PATCHes the one marker-matched project, preserving the marker', async () => {
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
    assert.equal(patch.body.data.name, `2601_Adidas_Summer Campaign ${MARKER}`)
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
})
