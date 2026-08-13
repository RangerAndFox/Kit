/**
 * Shared Frame.io next-link normalization tests.
 *
 * Reproduces the production defect that generated
 *   GET /v4/v4/accounts/.../projects  (404)
 * — a base-relative `links.next` that still carried the `/v4` API base path,
 * which the consumer then re-prepended. The helper canonicalizes every shape to
 * one rooted, base-relative path and fails closed on links it cannot follow.
 *
 * Run: npx tsx --test src/lib/frameio/url.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFrameioNextLink, FRAMEIO_API_BASE, frameioProjectUrl } from './url'

describe('normalizeFrameioNextLink — canonicalize to a base-relative rooted path', () => {
  it('strips a leading /v4 from a base-relative link (the /v4/v4 root cause)', () => {
    assert.equal(
      normalizeFrameioNextLink('/v4/accounts/ACC/workspaces/WKS/projects?page=2'),
      '/accounts/ACC/workspaces/WKS/projects?page=2',
    )
    // The fix in one line: re-prepending the base yields a single /v4, not /v4/v4.
    assert.equal(
      `${FRAMEIO_API_BASE}${normalizeFrameioNextLink('/v4/accounts/ACC/workspaces/WKS/projects')}`,
      'https://api.frame.io/v4/accounts/ACC/workspaces/WKS/projects',
    )
  })

  it('reduces a same-origin absolute URL to a rooted path (drops the /v4 base)', () => {
    assert.equal(
      normalizeFrameioNextLink('https://api.frame.io/v4/accounts/ACC/projects?page=3'),
      '/accounts/ACC/projects?page=3',
    )
  })

  it('leaves an already-rooted /accounts/... path unchanged', () => {
    assert.equal(
      normalizeFrameioNextLink('/accounts/ACC/projects?page=2'),
      '/accounts/ACC/projects?page=2',
    )
  })

  it('preserves the query string', () => {
    assert.equal(
      normalizeFrameioNextLink('/v4/accounts/ACC/projects?page=2&per_page=50'),
      '/accounts/ACC/projects?page=2&per_page=50',
    )
  })

  it('strips ONLY the leading base segment, not a deeper "v4"', () => {
    assert.equal(normalizeFrameioNextLink('/accounts/v4/projects'), '/accounts/v4/projects')
  })

  it('rejects a different origin (fail closed)', () => {
    assert.throws(
      () => normalizeFrameioNextLink('https://evil.example.com/v4/accounts/ACC/projects?page=2'),
      /frameio_pagination_ambiguous/,
    )
  })

  it('rejects empty / non-string links (fail closed)', () => {
    assert.throws(() => normalizeFrameioNextLink(''), /frameio_pagination_ambiguous/)
    assert.throws(() => normalizeFrameioNextLink('   '), /frameio_pagination_ambiguous/)
    assert.throws(() => normalizeFrameioNextLink({ href: 42 } as unknown), /frameio_pagination_ambiguous/)
    assert.throws(() => normalizeFrameioNextLink(null as unknown), /frameio_pagination_ambiguous/)
  })

  it('rejects a non-rooted relative link (fail closed)', () => {
    assert.throws(() => normalizeFrameioNextLink('accounts/ACC/projects'), /frameio_pagination_ambiguous/)
  })
})

describe('frameioProjectUrl — the canonical browser-facing project link', () => {
  it('uses the next.frame.io host and the SINGULAR /project/ path', () => {
    const url = frameioProjectUrl('abc123')
    assert.equal(url, 'https://next.frame.io/project/abc123')
    // Regression guards against the exact production defect
    // (https://app.frame.io/projects/{id}).
    assert.match(url, /^https:\/\/next\.frame\.io\/project\//)
    assert.doesNotMatch(url, /app\.frame\.io/)
    assert.doesNotMatch(url, /\/projects\//) // plural is the legacy shape
  })

  it('preserves the project id exactly (no encoding/trimming of interior)', () => {
    assert.equal(
      frameioProjectUrl('11111111-2222-3333-4444-555555555555'),
      'https://next.frame.io/project/11111111-2222-3333-4444-555555555555',
    )
  })

  it('trims surrounding whitespace on the id', () => {
    assert.equal(frameioProjectUrl('  abc123  '), 'https://next.frame.io/project/abc123')
  })

  it('is NOT the API base (never used for API calls)', () => {
    assert.notEqual(frameioProjectUrl('abc123'), `${FRAMEIO_API_BASE}/accounts/x/projects/abc123`)
  })

  it('fails closed on an empty / blank / non-string id', () => {
    assert.throws(() => frameioProjectUrl(''), /empty project id/)
    assert.throws(() => frameioProjectUrl('   '), /empty project id/)
    assert.throws(() => frameioProjectUrl(undefined as unknown as string), /empty project id/)
    assert.throws(() => frameioProjectUrl(null as unknown as string), /empty project id/)
  })
})
