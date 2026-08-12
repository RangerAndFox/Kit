/**
 * updateHarvestProject: PATCHes only the display fields (name/code) and NEVER
 * sends budget (Harvest budgets are fixed at creation).
 *
 * Run: npx tsx --test src/lib/harvest/client.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { updateHarvestProject } from './client'

const origFetch = globalThis.fetch

beforeEach(() => {
  process.env.HARVEST_ACCESS_TOKEN = 'tok'
  process.env.HARVEST_ACCOUNT_ID = 'acct'
})
afterEach(() => {
  globalThis.fetch = origFetch
})

describe('updateHarvestProject', () => {
  it('sends a PATCH with only name + code, and maps the response', async () => {
    let seen: { method?: string; url?: string; body?: any } = {}
    globalThis.fetch = (async (url: any, init: any) => {
      seen = { method: init?.method, url: String(url), body: JSON.parse(init?.body || '{}') }
      return {
        ok: true,
        json: async () => ({ id: 55, name: 'New Name', code: '2601-Adidas', is_active: true, client: { id: 9, name: 'Adidas' } }),
      }
    }) as any

    const p = await updateHarvestProject({ projectId: 55, name: 'New Name', code: '2601-Adidas' })

    assert.equal(seen.method, 'PATCH')
    assert.ok(seen.url!.endsWith('/projects/55'))
    assert.deepEqual(seen.body, { name: 'New Name', code: '2601-Adidas' })
    // Budget must never be part of the update.
    assert.equal('budget' in (seen.body as object), false)
    assert.equal(p.id, 55)
    assert.equal(p.name, 'New Name')
    assert.equal(p.code, '2601-Adidas')
  })

  it('omits code when only the name changes', async () => {
    let body: any = null
    globalThis.fetch = (async (_url: any, init: any) => {
      body = JSON.parse(init?.body || '{}')
      return { ok: true, json: async () => ({ id: 7, name: 'X', code: '', is_active: true }) }
    }) as any
    await updateHarvestProject({ projectId: 7, name: 'X' })
    assert.deepEqual(body, { name: 'X' })
  })

  it('throws on a non-2xx response', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 422, text: async () => 'bad' })) as any
    await assert.rejects(() => updateHarvestProject({ projectId: 1, name: 'Y' }), /Harvest PATCH .*422/)
  })
})
