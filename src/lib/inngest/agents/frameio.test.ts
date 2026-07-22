/**
 * Frame.io reconciliation pagination tests.
 *
 * findFrameioProjectsByKitId must enumerate EVERY page before concluding, so a
 * project that lives on a later page is never missed and absence (→ create) is
 * only concluded off a fully-read list. Any pagination/list ambiguity fails
 * closed (throws) so a duplicate project is never created off a partial read.
 *
 * Run: npx tsx --test src/lib/inngest/agents/frameio.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { findFrameioProjectsByKitId, frameioKitMarker } from './frameio'

const ACCT = 'ACC'
const WS = 'WKS'
const KIT = 'kit-uuid-123'
const MARKER = frameioKitMarker(KIT)
const START = `/accounts/${ACCT}/workspaces/${WS}/projects`
const API = 'https://api.frame.io/v4'

/**
 * Build a fetchPage fake from an ordered list of page payloads, auto-wiring a
 * `links.next` onto every page but the last so the walker enumerates them all.
 */
function pager(
  pages: Array<Record<string, unknown>>,
  opts?: { linkStyle?: 'relative' | 'absolute' | 'v4relative' },
) {
  const style = opts?.linkStyle ?? 'relative'
  const calls: string[] = []
  const wired = pages.map((page, i) => {
    if (i >= pages.length - 1) return page // last page: no next link
    const nextRel = `${START}?page=${i + 2}`
    const next =
      style === 'absolute'
        ? `${API}${nextRel}` // https://api.frame.io/v4/accounts/...
        : style === 'v4relative'
          ? `/v4${nextRel}` // the exact production shape → /v4/accounts/... (root cause)
          : nextRel // base-relative /accounts/...
    return { ...page, links: { next } }
  })
  const fetchPage = async (path: string) => {
    const payload = wired[calls.length]
    calls.push(path)
    if (payload === undefined) throw new Error(`unexpected extra page fetch: ${path}`)
    return payload
  }
  return { fetchPage, calls }
}

function proj(name: string, id: string, root = `${id}-root`) {
  return { id, name, root_folder_id: root }
}

describe('findFrameioProjectsByKitId — enumerate all pages', () => {
  it('returns [] without fetching for an empty kit id', async () => {
    let called = false
    const out = await findFrameioProjectsByKitId(ACCT, WS, '', async () => {
      called = true
      return { data: [] }
    })
    assert.deepEqual(out, [])
    assert.equal(called, false)
  })

  it('concludes absence (zero matches) only after reading every page', async () => {
    const { fetchPage, calls } = pager([
      { data: [proj('2600_A [kit:other-1]', 'p1'), proj('2601_B', 'p2')] },
      { data: [proj('2602_C [kit:other-2]', 'p3')] },
      { data: [proj('2603_D', 'p4')] },
    ])
    const out = await findFrameioProjectsByKitId(ACCT, WS, KIT, fetchPage)
    assert.deepEqual(out, []) // absence PROVEN across 3 pages → caller creates
    assert.equal(calls.length, 3)
  })

  it('finds a single match that lives on a LATER page (reuse, not duplicate)', async () => {
    const { fetchPage, calls } = pager([
      { data: [proj('2600_A [kit:other]', 'p1')] },
      { data: [proj('2601_B', 'p2')] },
      { data: [proj(`2602_C ${MARKER}`, 'pMATCH', 'root-x')] },
    ])
    const out = await findFrameioProjectsByKitId(ACCT, WS, KIT, fetchPage)
    assert.deepEqual(out, [{ id: 'pMATCH', rootFolderId: 'root-x' }])
    assert.equal(calls.length, 3) // walked all pages to reach the match
  })

  it('follows /v4-prefixed relative next links without producing /v4/v4 (production shape)', async () => {
    const { fetchPage, calls } = pager(
      [
        { data: [proj('2600_A', 'p1')] },
        { data: [proj(`2601_B ${MARKER}`, 'pMATCH')] },
      ],
      { linkStyle: 'v4relative' },
    )
    const out = await findFrameioProjectsByKitId(ACCT, WS, KIT, fetchPage)
    assert.equal(out.length, 1)
    assert.equal(out[0].id, 'pMATCH')
    // Page 2 must be requested as a base-relative path (no leading /v4); the
    // caller re-prepends the /v4 base, so a retained /v4 would 404 as /v4/v4.
    assert.equal(calls[1], `${START}?page=2`)
    assert.ok(!calls[1].startsWith('/v4/'))
  })

  it('follows absolute-URL next links (normalized back to a relative path)', async () => {
    const { fetchPage } = pager(
      [
        { data: [proj('2600_A', 'p1')] },
        { data: [proj(`2601_B ${MARKER}`, 'pMATCH')] },
      ],
      { linkStyle: 'absolute' },
    )
    const out = await findFrameioProjectsByKitId(ACCT, WS, KIT, fetchPage)
    assert.equal(out.length, 1)
    assert.equal(out[0].id, 'pMATCH')
  })

  it('returns ALL matches (≥2) so the caller can fail closed on ambiguity', async () => {
    const { fetchPage } = pager([
      { data: [proj(`2600_A ${MARKER}`, 'dup1')] },
      { data: [proj(`2600_A ${MARKER}`, 'dup2')] },
    ])
    const out = await findFrameioProjectsByKitId(ACCT, WS, KIT, fetchPage)
    assert.deepEqual(out.map((m) => m.id).sort(), ['dup1', 'dup2'])
  })

  it('handles a single page with no links as complete (bare array payload)', async () => {
    const out = await findFrameioProjectsByKitId(ACCT, WS, KIT, async () => [
      proj(`2600_A ${MARKER}`, 'pMATCH'),
    ])
    assert.deepEqual(out, [{ id: 'pMATCH', rootFolderId: 'pMATCH-root' }])
  })
})

describe('findFrameioProjectsByKitId — fail closed on ambiguity', () => {
  it('throws on an unrecognized (non-list) page payload — never reads it as zero', async () => {
    await assert.rejects(
      findFrameioProjectsByKitId(ACCT, WS, KIT, async () => ({ error: 'nope', results: {} })),
      /frameio_list_ambiguous/,
    )
  })

  it('throws when a next link is present but points to a different host', async () => {
    const fetchPage = async () => ({
      data: [proj('2600_A', 'p1')],
      links: { next: 'https://evil.example.com/v4/accounts/ACC/workspaces/WKS/projects?page=2' },
    })
    await assert.rejects(
      findFrameioProjectsByKitId(ACCT, WS, KIT, fetchPage),
      /frameio_pagination_ambiguous/,
    )
  })

  it('throws on a malformed (non-string) next link', async () => {
    const fetchPage = async () => ({ data: [proj('2600_A', 'p1')], links: { next: { href: 42 } } })
    await assert.rejects(
      findFrameioProjectsByKitId(ACCT, WS, KIT, fetchPage),
      /frameio_pagination_ambiguous/,
    )
  })

  it('throws on a pagination cycle (next points back to a visited page)', async () => {
    const fetchPage = async () => ({
      data: [proj('2600_A', 'p1')],
      links: { next: START }, // always points to itself
    })
    await assert.rejects(
      findFrameioProjectsByKitId(ACCT, WS, KIT, fetchPage),
      /frameio_pagination_ambiguous/,
    )
  })

  it('throws when the page cap is reached before the list ends (unbounded next chain)', async () => {
    let n = 0
    const fetchPage = async () => {
      n++
      // Always advertise a fresh next page → never terminates on its own.
      return { data: [proj(`2600_${n}`, `p${n}`)], links: { next: `${START}?page=${n + 1}` } }
    }
    await assert.rejects(
      findFrameioProjectsByKitId(ACCT, WS, KIT, fetchPage),
      /frameio_pagination_ambiguous/,
    )
  })
})
