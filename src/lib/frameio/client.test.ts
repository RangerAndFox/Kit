/**
 * Frame.io client comment-pagination tests.
 *
 * getAssetComments walks v4 `links.next` pagination. The shared normalization
 * fix ensures a base-relative `/v4/...` next link is not re-prepended into a
 * `/v4/v4/...` 404. fetchPage is injected so the walk is tested without auth or
 * network.
 *
 * Run: npx tsx --test src/lib/frameio/client.test.ts
 */

import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'

before(() => {
  process.env.FRAMEIO_ACCOUNT_ID = 'ACC'
})

const FILE = 'FILE1'
const START = `/accounts/ACC/files/${FILE}/comments`

async function load() {
  return import('./client')
}

describe('getAssetComments — pagination', () => {
  it('follows /v4-prefixed relative next links without producing /v4/v4', async () => {
    const { getAssetComments } = await load()
    const calls: string[] = []
    const pages = [
      { data: [{ id: 'c1', text: 'one' }], links: { next: `/v4${START}?page=2` } },
      { data: [{ id: 'c2', text: 'two' }] }, // no next → terminal
    ]
    const fetchPage = async (path: string) => {
      const p = pages[calls.length]
      calls.push(path)
      if (!p) throw new Error(`unexpected extra page fetch: ${path}`)
      return p
    }
    const out = await getAssetComments(FILE, fetchPage)
    assert.equal(out.length, 2)
    assert.deepEqual(out.map((c) => c.id), ['c1', 'c2'])
    // Page 2 requested as a base-relative path (no /v4 prefix) → no /v4/v4.
    assert.equal(calls[1], `${START}?page=2`)
    assert.ok(!calls[1].startsWith('/v4/'))
  })

  it('stops on a cross-host next link and returns what it has (no throw)', async () => {
    const { getAssetComments } = await load()
    const fetchPage = async () => ({
      data: [{ id: 'c1', text: 'one' }],
      links: { next: 'https://evil.example.com/v4/accounts/ACC/files/FILE1/comments?page=2' },
    })
    const out = await getAssetComments(FILE, fetchPage)
    assert.deepEqual(out.map((c) => c.id), ['c1'])
  })

  it('terminates normally when no next link is present', async () => {
    const { getAssetComments } = await load()
    let count = 0
    const fetchPage = async () => {
      count++
      return { data: [{ id: 'only', text: 'x' }] }
    }
    const out = await getAssetComments(FILE, fetchPage)
    assert.equal(out.length, 1)
    assert.equal(count, 1)
  })
})
