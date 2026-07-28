/**
 * Shared Frame.io URL normalization.
 *
 * The v4 API base carries a `/v4` path segment. Reconciliation and comment
 * pagination follow `links.next`, which Frame.io returns in several shapes:
 *   - an absolute URL:            https://api.frame.io/v4/accounts/...?page=2
 *   - a base-relative path:       /v4/accounts/...?page=2
 *   - an already-rooted API path: /accounts/...?page=2
 *
 * Every consumer prepends the API base again when fetching, so a next link
 * that still carries `/v4` produces `/v4/v4/accounts/...` and 404s. This helper
 * canonicalizes any next link to ONE base-relative rooted path (no leading
 * `/v4`), stripping ONLY the base-path segment — never an arbitrary "v4" that
 * happens to appear elsewhere in the path — and fails closed on anything it
 * cannot safely follow so a partial read is never mistaken for a complete one.
 */

export const FRAMEIO_API_BASE = 'https://api.frame.io/v4'

/**
 * The current Frame.io (Adobe-era) browser host + path for a project. The old
 * `https://app.frame.io/projects/{id}` host now redirects/breaks; the live
 * browser URL is `https://next.frame.io/project/{id}` (singular `project`).
 *
 * This is the ONE place a browser-facing project link is constructed. It is NOT
 * the API base (`FRAMEIO_API_BASE`, `/accounts/{acct}/projects/{id}`) — never
 * use this for API calls.
 *
 * Fails closed on an empty/blank id (same discipline as
 * `normalizeFrameioNextLink`): a link to `.../project/` with no id is worse than
 * an error, because it would be silently stored/rendered as if valid.
 */
export function frameioProjectUrl(projectId: string): string {
  const id = typeof projectId === 'string' ? projectId.trim() : ''
  if (!id) throw new Error('frameioProjectUrl: empty project id')
  return `https://next.frame.io/project/${id}`
}

/**
 * Canonicalize a `links.next` value to a rooted, base-relative path
 * (`/accounts/...`), preserving the query string.
 *
 * Throws (fail closed) when the link cannot be safely followed:
 *   - empty / non-string           → malformed
 *   - unparseable absolute URL      → malformed
 *   - absolute URL on another host  → different host
 *   - a path that is not rooted     → malformed
 *
 * The caller is responsible for the NORMAL terminal signal (a null/absent
 * next link) — this helper is only invoked for a present next value.
 */
export function normalizeFrameioNextLink(next: unknown, base: string = FRAMEIO_API_BASE): string {
  if (typeof next !== 'string' || next.trim() === '') {
    throw new Error('frameio_pagination_ambiguous: malformed next link')
  }

  const baseUrl = new URL(base)
  let rel = next.trim()

  // Absolute URL: must be the SAME origin as the API base; reduce to path+query.
  if (/^https?:\/\//i.test(rel)) {
    let u: URL
    try {
      u = new URL(rel)
    } catch {
      throw new Error('frameio_pagination_ambiguous: malformed next link')
    }
    if (u.origin !== baseUrl.origin) {
      throw new Error('frameio_pagination_ambiguous: next link points to a different host')
    }
    rel = u.pathname + u.search
  }

  // Strip ONLY the leading API base-path segment (e.g. "/v4"), not arbitrary
  // "v4" occurrences deeper in the path.
  const basePath = baseUrl.pathname.replace(/\/+$/, '') // "/v4"
  if (basePath && basePath !== '/') {
    if (rel === basePath) {
      rel = '/'
    } else if (rel.startsWith(basePath + '/')) {
      rel = rel.slice(basePath.length)
    }
  }

  if (!rel.startsWith('/')) {
    throw new Error('frameio_pagination_ambiguous: malformed next link')
  }
  return rel
}
