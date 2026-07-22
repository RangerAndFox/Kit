// @ts-nocheck
/**
 * Frame.io v4 API Client
 *
 * Migrated from v2 to v4 (Adobe-era API).
 * Key changes:
 *   - Base URL: /v4 instead of /v2
 *   - "teams" → "workspaces", "assets" → "files/folders", "review_links" → "shares"
 *   - All resource paths include account_id prefix
 *   - Responses wrapped in { data: ... }
 *   - Request bodies use { data: { ... } }
 *   - Auth via Adobe IMS OAuth (handled by ./auth.ts)
 */

import { frameioHeaders } from './auth'
import { normalizeFrameioNextLink, FRAMEIO_API_BASE } from './url'

const BASE_URL = FRAMEIO_API_BASE

function getAccountId(): string {
  const id = process.env.FRAMEIO_ACCOUNT_ID
  if (!id) throw new Error('FRAMEIO_ACCOUNT_ID is required for Frame.io v4 API')
  return id
}

async function frameioGet(path: string): Promise<any> {
  const hdrs = await frameioHeaders()
  const res = await fetch(`${BASE_URL}${path}`, { headers: hdrs })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Frame.io ${path}: ${res.status} ${body}`)
  }
  return res.json()
}

async function frameioPost(path: string, body: Record<string, unknown>): Promise<any> {
  const hdrs = await frameioHeaders()
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Frame.io POST ${path}: ${res.status} ${errBody}`)
  }
  return res.json()
}

// ─── Types ──────────────────────────────────────────────────

export interface FrameIoComment {
  id: string
  text: string
  timestamp: number | null    // seconds into video (null = general comment)
  ownerName: string
  ownerEmail: string
  createdAt: string
  completed: boolean
}

export interface FrameIoAsset {
  id: string
  name: string
  type: string               // 'file' | 'folder' | 'version_stack'
  duration: number | null     // seconds
  thumbUrl: string | null
  proxyUrl: string | null
  originalUrl: string | null
  hlsUrl: string | null
}

// ─── User / Account ────────────────────────────────────────

// ─── Review Link / Share Resolution ─────────────────────────

/**
 * Extract a share (review link) ID from a Frame.io URL.
 * v4 renamed "review_links" to "shares"
 * Supports:
 *   https://app.frame.io/reviews/{id}
 *   https://app.frame.io/shares/{id}
 */
export function parseReviewUrl(url: string): string | null {
  const match = url.match(/frame\.io\/(?:reviews|shares)\/([a-f0-9-]+)/i)
  return match ? match[1] : null
}

/**
 * Extract a file ID from a Frame.io player URL.
 *   https://app.frame.io/player/{file_id}
 */
export function parseAssetUrl(url: string): string | null {
  const match = url.match(/frame\.io\/player\/([a-f0-9-]+)/i)
  return match ? match[1] : null
}

/**
 * Resolve a share to its files.
 * v4: GET /v4/shares/{share_id}/items  (shares may be account-agnostic)
 */
export async function getReviewLinkAssets(shareId: string): Promise<FrameIoAsset[]> {
  const acct = getAccountId()
  try {
    const data = await frameioGet(`/accounts/${acct}/shares/${shareId}/items`)
    const items = data.data || data.items || data
    return (Array.isArray(items) ? items : []).map(normalizeAsset)
  } catch {
    // Fallback: try without account prefix
    try {
      const data = await frameioGet(`/shares/${shareId}/items`)
      const items = data.data || data.items || data
      return (Array.isArray(items) ? items : []).map(normalizeAsset)
    } catch {
      return []
    }
  }
}

/**
 * Get a single file by ID.
 * GET /v4/accounts/{account_id}/files/{file_id}
 */
export async function getAsset(fileId: string): Promise<FrameIoAsset> {
  const acct = getAccountId()
  const data = await frameioGet(`/accounts/${acct}/files/${fileId}`)
  return normalizeAsset(data.data || data)
}

// ─── Comments ───────────────────────────────────────────────

/**
 * Fetch ALL comments for a file, following v4 cursor pagination.
 * GET /v4/accounts/{account_id}/files/{file_id}/comments
 *
 * Without the pagination walk, heavily-reviewed cuts silently truncated at
 * the API's default page size — the exported notes doc just missed comments.
 */
export async function getAssetComments(
  fileId: string,
  fetchPage: (path: string) => Promise<unknown> = frameioGet,
): Promise<FrameIoComment[]> {
  const acct = getAccountId()
  const all: any[] = []
  let path: string | null = `/accounts/${acct}/files/${fileId}/comments`
  let safety = 20 // pagination cap — thousands of comments means something is wrong

  while (path && safety-- > 0) {
    const data = await fetchPage(path)
    const items = data.data || data.comments || data.items || data
    if (Array.isArray(items)) all.push(...items)

    // v4 list responses carry links.next (absolute URL or path) when there are
    // more pages; its absence is the normal terminal signal. Canonicalize via
    // the shared helper (strips a leading "/v4" so fetchPage does not re-prepend
    // it → the /v4/v4 404). A malformed / cross-host link is not followed.
    const next: unknown = data.links?.next ?? data.links?.next_page
    if (next == null) {
      path = null
    } else {
      try {
        path = normalizeFrameioNextLink(next)
      } catch {
        break // malformed / cross-host next link — stop, return what we have
      }
    }
  }

  return all.map((c: any) => ({
    id: c.id,
    text: c.text || '',
    timestamp: typeof c.timestamp === 'number' ? c.timestamp : null,
    ownerName: c.owner?.name || c.owner_name || c.creator?.name || 'Unknown',
    ownerEmail: c.owner?.email || c.owner_email || c.creator?.email || '',
    createdAt: c.inserted_at || c.created_at || '',
    completed: c.completed || c.resolved || false,
  }))
}

// ─── Thumbnail / Frame Extraction ───────────────────────────

/**
 * Get a thumbnail URL for a specific timecode.
 */
export async function getFrameAtTimecode(
  fileId: string,
  timecodeSeconds: number
): Promise<{ url: string; source: 'frame' | 'thumb' | 'poster' } | null> {
  try {
    const asset = await getAsset(fileId)
    if (asset.thumbUrl) {
      return { url: asset.thumbUrl, source: 'poster' }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Download an image from a URL and return it as a Buffer.
 */
export async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch {
    return null
  }
}

// ─── Helpers ────────────────────────────────────────────────

function normalizeAsset(raw: any): FrameIoAsset {
  return {
    id: raw.id,
    name: raw.name || 'Untitled',
    type: raw.type || raw.resource_type || 'file',
    duration: typeof raw.duration === 'number' ? raw.duration : null,
    thumbUrl: raw.thumb || raw.thumb_url || raw.thumbnail_url || raw.thumbnail || null,
    proxyUrl: raw.proxy || raw.proxy_url || null,
    originalUrl: raw.original || raw.original_url || null,
    hlsUrl: raw.hls_manifest || raw.hls_url || null,
  }
}

/**
 * Format seconds to HH:MM:SS:FF timecode (at 24fps).
 */
export function formatTimecode(seconds: number, fps = 24): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const f = Math.floor((seconds % 1) * fps)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`
}

/**
 * Detect if a string contains a Frame.io URL and return the parsed info.
 */
export function detectFrameIoLink(text: string): {
  type: 'review' | 'asset' | 'short'
  id: string
  url: string
} | null {
  const urlMatch = text.match(/<?(https?:\/\/[^\s>|]*(?:frame\.io|f\.io)[^\s>|]*)>?/)
  if (!urlMatch) return null

  const url = urlMatch[1]

  const reviewId = parseReviewUrl(url)
  if (reviewId) return { type: 'review', id: reviewId, url }

  const assetId = parseAssetUrl(url)
  if (assetId) return { type: 'asset', id: assetId, url }

  const shortMatch = url.match(/f\.io\/([a-zA-Z0-9]+)/i)
  if (shortMatch) return { type: 'short', id: shortMatch[1], url }

  return null
}

/**
 * Resolve a short Frame.io link (f.io/xxx) by following the redirect.
 */
export async function resolveShortLink(shortUrl: string): Promise<{
  type: 'review' | 'asset'
  id: string
  url: string
} | null> {
  try {
    const res = await fetch(shortUrl, { redirect: 'follow' })
    const finalUrl = res.url

    console.log('[FrameIO] Short link resolved:', shortUrl, '->', finalUrl)

    const reviewId = parseReviewUrl(finalUrl)
    if (reviewId) return { type: 'review', id: reviewId, url: finalUrl }

    const assetId = parseAssetUrl(finalUrl)
    if (assetId) return { type: 'asset', id: assetId, url: finalUrl }

    const anyReviewMatch = finalUrl.match(/frame\.io.*?\/(?:reviews?|shares?)\/([a-f0-9-]+)/i)
    if (anyReviewMatch) return { type: 'review', id: anyReviewMatch[1], url: finalUrl }

    const anyPlayerMatch = finalUrl.match(/frame\.io.*?\/player\/([a-f0-9-]+)/i)
    if (anyPlayerMatch) return { type: 'asset', id: anyPlayerMatch[1], url: finalUrl }

    const uuidMatch = finalUrl.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i)
    if (uuidMatch) return { type: 'review', id: uuidMatch[1], url: finalUrl }

    console.warn('[FrameIO] Could not parse resolved URL:', finalUrl)
    return null
  } catch (err: any) {
    console.error('[FrameIO] Short link resolution failed:', err?.message)
    return null
  }
}
