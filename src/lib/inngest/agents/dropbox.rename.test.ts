/**
 * Dropbox move/rename (the 'rename' action): moves the project folder within its
 * OWN year, keeps external_ids.dropbox_safe_name derivable from the new path, and
 * is idempotent on resume (to_path exists / from_path gone → treated as done).
 *
 * Run: npx tsx --test src/lib/inngest/agents/dropbox.rename.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { dropboxAgent } from './dropbox'
import { deriveDropboxSafeName } from '@/lib/provisioner/identifiers'

const origFetch = globalThis.fetch
const NEW_SAFE = deriveDropboxSafeName('2601', 'Adidas', 'Summer Campaign')

beforeEach(() => {
  // Force the static-token path so dropboxHeaders makes no network call.
  delete process.env.DROPBOX_APP_KEY
  delete process.env.DROPBOX_APP_SECRET
  delete process.env.DROPBOX_REFRESH_TOKEN
  process.env.DROPBOX_ACCESS_TOKEN = 'static-test-token'
})
afterEach(() => {
  globalThis.fetch = origFetch
})

/** Route Dropbox RPC calls by endpoint path to a handler map. */
function dropboxMock(handlers: Record<string, (body: any) => { ok: boolean; status?: number; text?: string; json?: any }>) {
  const calls: Array<{ endpoint: string; body: any }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    const endpoint = new URL(String(url)).pathname.replace('/2', '') // strip the /2 API prefix
    const body = init?.body ? JSON.parse(init.body) : {}
    calls.push({ endpoint, body })
    const h = handlers[endpoint]
    if (!h) return { ok: true, json: async () => ({}) }
    const r = h(body)
    if (!r.ok) return { ok: false, status: r.status ?? 409, text: async () => r.text ?? 'error' }
    return { ok: true, json: async () => r.json ?? {} }
  }) as any
  return calls
}

const link = { ok: true, json: { url: 'https://dropbox/link' } }

describe("dropbox 'rename' (move folder)", () => {
  it('moves within the same year and returns the new path + safe name', async () => {
    const calls = dropboxMock({
      '/files/move_v2': () => ({ ok: true, json: { metadata: {} } }),
      '/sharing/create_shared_link_with_settings': () => link,
    })
    const res: any = await dropboxAgent.handler('rename', {
      projectId: 'P', fromPath: '/production/2026/2601_Nike_Old_Name',
      projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign',
    })
    assert.equal(res.success, true)
    assert.equal(res.id, `/production/2026/${NEW_SAFE}`)
    assert.equal(res.data.newSafeName, NEW_SAFE)
    const move = calls.find((c) => c.endpoint === '/files/move_v2')!
    assert.equal(move.body.from_path, '/production/2026/2601_Nike_Old_Name')
    assert.equal(move.body.to_path, `/production/2026/${NEW_SAFE}`)
    assert.equal(move.body.autorename, false)
  })

  it("keeps a project under its ORIGINAL year (2025), not the current year", async () => {
    const calls = dropboxMock({
      '/files/move_v2': () => ({ ok: true, json: {} }),
      '/sharing/create_shared_link_with_settings': () => link,
    })
    const res: any = await dropboxAgent.handler('rename', {
      projectId: 'P', fromPath: '/production/2025/old',
      projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign',
    })
    assert.equal(res.id, `/production/2025/${NEW_SAFE}`)
    assert.ok(calls.find((c) => c.endpoint === '/files/move_v2')!.body.to_path.startsWith('/production/2025/'))
  })

  it('treats a from-missing move as done ONLY when the source is gone and the destination exists (resumed move)', async () => {
    const from = '/production/2026/old'
    const to = `/production/2026/${NEW_SAFE}`
    dropboxMock({
      '/files/move_v2': () => ({ ok: false, status: 409, text: 'path_lookup/not_found/..' }),
      // source gone, destination present → the move already landed.
      '/files/get_metadata': (b: any) => (b.path === from ? { ok: false, status: 409, text: 'not_found' } : { ok: true, json: { '.tag': 'folder' } }),
      '/sharing/create_shared_link_with_settings': () => link,
    })
    const res: any = await dropboxAgent.handler('rename', {
      projectId: 'P', fromPath: from,
      projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign',
    })
    assert.equal(res.success, true)
    assert.equal(res.id, to)
  })

  it('is TERMINAL on a genuine collision — a conflict while the source still exists (another folder occupies the destination)', async () => {
    // Both the source AND the destination exist: the destination is a DIFFERENT
    // folder (safe-name collision / scratch folder), never our completed move.
    dropboxMock({
      '/files/move_v2': () => ({ ok: false, status: 409, text: 'path/conflict/folder/..' }),
      '/files/get_metadata': () => ({ ok: true, json: { '.tag': 'folder' } }), // every path exists
    })
    const res: any = await dropboxAgent.handler('rename', {
      projectId: 'P', fromPath: '/production/2026/old',
      projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign',
    })
    assert.equal(res.success, false)
    assert.equal(res.terminal, true)
    assert.match(res.error, /dropbox_move_conflict/)
  })

  it('fails (retryable) when the destination does NOT exist after a move error', async () => {
    dropboxMock({
      '/files/move_v2': () => ({ ok: false, status: 409, text: 'path/conflict/..' }),
      '/files/get_metadata': () => ({ ok: false, status: 409, text: 'not_found' }),
    })
    const res: any = await dropboxAgent.handler('rename', {
      projectId: 'P', fromPath: '/production/2026/old',
      projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign',
    })
    assert.equal(res.success, false)
    assert.notEqual(res.terminal, true) // dest missing → retryable, not terminal
  })

  it('is terminal when fromPath is missing', async () => {
    dropboxMock({})
    const res: any = await dropboxAgent.handler('rename', { projectId: 'P', projectNumber: '2601', client: 'Adidas', projectName: 'Summer Campaign' })
    assert.equal(res.success, false)
    assert.equal(res.terminal, true)
  })
})
