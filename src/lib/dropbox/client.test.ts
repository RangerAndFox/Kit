/**
 * dropboxRpc error-context tests. Verifies an aborted request is re-thrown with
 * the endpoint + timeout budget it happened on, while preserving the original
 * DOMException as `cause` and never leaking credentials.
 *
 * Run: npx tsx --test src/lib/dropbox/client.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { dropboxRpc } from './client'

const origFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ['DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN', 'DROPBOX_ACCESS_TOKEN']) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  // Static-token path so dropboxHeaders() doesn't attempt a network refresh.
  process.env.DROPBOX_ACCESS_TOKEN = 'test-token-do-not-log'
})

afterEach(() => {
  globalThis.fetch = origFetch
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('dropboxRpc error context', () => {
  it('wraps an AbortSignal.timeout with the endpoint + budget and preserves the cause', async () => {
    const original = new Error('The operation was aborted due to timeout')
    original.name = 'TimeoutError'
    globalThis.fetch = (async () => {
      throw original
    }) as typeof fetch

    await assert.rejects(
      () => dropboxRpc('/files/list_folder', { path: '/production', recursive: true }, 15_000),
      (err: any) => {
        assert.equal(err.message, 'Dropbox /files/list_folder timed out after 15000ms')
        assert.equal(err.cause, original) // original DOMException retained
        assert.ok(!/test-token-do-not-log/.test(err.message)) // no credential leak
        return true
      },
    )
  })

  it('wraps a generic network failure with the endpoint too', async () => {
    const original = new Error('ECONNRESET')
    globalThis.fetch = (async () => {
      throw original
    }) as typeof fetch

    await assert.rejects(
      () => dropboxRpc('/files/list_folder/continue', { cursor: 'abc' }),
      (err: any) => {
        assert.match(err.message, /^Dropbox \/files\/list_folder\/continue request failed:/)
        assert.equal(err.cause, original)
        return true
      },
    )
  })

  it('returns parsed JSON on success', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ entries: [], has_more: false }),
    })) as unknown as typeof fetch

    const r = await dropboxRpc('/files/list_folder', { path: '/production' })
    assert.deepEqual(r, { entries: [], has_more: false })
  })
})
