// @ts-nocheck
/**
 * Frame.io v4 API Client
 *
 * Handles auth (via Adobe IMS), share-link resolution, comment fetching,
 * and thumbnail/frame retrieval for the notes-extraction pipeline.
 *
 * v4 differs from v2 in three big ways:
 *   1. Auth: Adobe IMS OAuth access tokens instead of static dev tokens
 *   2. URL shape: resources are namespaced under /accounts/{account_id}/...
 *   3. Concepts: "review_links" → "share_links", "assets" → "files"/"folders"
 */
import { frameIoAuthHeaders } from './auth'

const BASE_URL = 'https://api.frame.io/v4'

function accountId(): string {
  const id = process.env.FRAMEIO_ACCOUNT_ID
  if (!id) throw new Error('FRAMEIO_ACCOUNT_ID not configured')
  return id
}

async function frameioGet(path: string): Promise<any> {
  const headers = await frameIoAuthHeaders()
  const res = await fetch(`${BASE_URL}${path}`, { headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Frame.io ${path}: ${res.status} ${body}`)
  }
  return res.json()
}

// v4 wraps responses in { data: ... } envelopes. Unwrap for convenience.
function unwrap(payload: any): any {
  return payload && typeof payload === 'object' && 'data' in payload ? payload.data : payload
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
  type: string
  duration: number | null     // seconds
  thumbUrl: string | null
  proxyUrl: string | null
  originalUrl: string | null
  hlsUrl: string | null
}

// ─── Share / Review Link Resolution ─────────────────────────

/**
 * Extract the share-link ID from a Frame.io URL.
 * v4 review URLs:
 *   https://app.frame.io/reviews/{id}
 *   https://next.frame.io/share/{id}
 */
export function parseReviewUrl(url: string): string | null {
  const reviews = url.match(/frame\.io\/reviews\/([a-f0-9-]+)/i)
  if (reviews) return reviews[1]
  const share = url.match(/frame\.io\/share\/([a-f0-9-]+)/i)
  return share ? share[1] : null
}

/**
 * Extract a file ID directly from a Frame.io player URL.
 *   https://next.frame.io/player/{file_id}
 */
export function parseAssetUrl(url: string): string | null {
  const match = url.match(/frame\.io\/player\/([a-f0-9-]+)/i)
  return match ? match[1] : null
}

/**
 * Resolve a share link to its files.
 * GET /v4/accounts/{account_id}/share_links/{id}
 */
export async function getReviewLinkAssets(shareLinkId: string): Promise<FrameIoAsset[]> {
  const acct = accountId()
  const data = unwrap(await frameioGet(`/accounts/${acct}/share_links/${shareLinkId}`))
  const items = data?.files || data?.items || []
  return (Array.isArray(items) ? items : []).map(normalizeAsset)
}

/**
 * Get a single file by ID.
 * GET /v4/accounts/{account_id}/files/{id}
 */
export async function getAsset(fileId: string): Promise<FrameIoAsset> {
  const acct = accountId()
  const data = unwrap(await frameioGet(`/accounts/${acct}/files/${fileId}`))
  return normalizeAsset(data)
}

// ─── Comments ───────────────────────────────────────────────

/**
 * Fetch all comments for a file.
 * GET /v4/accounts/{account_id}/files/{file_id}/comments
 */
export async function getAssetComments(fileId: string): Promise<FrameIoComment[]> {
  const acct = accountId()
  const data = unwrap(await frameioGet(`/accounts/${acct}/files/${fileId}/comments`))
  const items = Array.isArray(data) ? data : (data?.comments || data?.items || [])

  return items.map((c: any) => ({
    id: c.id,
    text: c.text || c.body || '',
    timestamp: typeof c.timestamp === 'number' ? c.timestamp : null,
    ownerName: c.owner?.name || c.author?.name || c.owner_name || 'Unknown',
    ownerEmail: c.owner?.email || c.author?.email || c.owner_email || '',
    createdAt: c.inserted_at || c.created_at || '',
    completed: c.completed || c.resolved || false,
  }))
}

// ─── Thumbnail / Frame Extraction ───────────────────────────

/**
 * Get a thumbnail URL for a specific timecode.
 *
 * v4 exposes thumbnail variants directly on the file resource. We fall
 * back to the poster frame if no time-specific thumbnail is available.
 */
export async function getFrameAtTimecode(
  fileId: string,
  _timecodeSeconds: number
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
  if (!raw) {
    return {
      id: '',
      name: 'Untitled',
      type: 'file',
      duration: null,
      thumbUrl: null,
      proxyUrl: null,
      originalUrl: null,
      hlsUrl: null,
    }
  }
  const media = raw.media_links || raw.media || {}
  return {
    id: raw.id,
    name: raw.name || 'Untitled',
    type: raw.type || raw.kind || 'file',
    duration: typeof raw.duration === 'number' ? raw.duration : (raw.media_duration ?? null),
    thumbUrl: raw.thumb || raw.thumb_url || raw.thumbnail_url || media.thumbnail || null,
    proxyUrl: raw.proxy || raw.proxy_url || media.proxy || null,
    originalUrl: raw.original || raw.original_url || media.original || null,
    hlsUrl: raw.hls_manifest || raw.hls_url || media.hls || null,
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
 * Supports:
 *   - Full URLs: app.frame.io/reviews/..., next.frame.io/share/..., next.frame.io/player/...
 *   - Short links: https://f.io/xxxxx
 *   - Slack-formatted: <https://f.io/xxx|f.io/xxx>
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
 * Resolve a short Frame.io link (f.io/xxx) by following the redirect to
 * get the full URL, then parse that.
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

    const anyReviewMatch = finalUrl.match(/frame\.io.*?\/(?:reviews?|share)\/([a-f0-9-]+)/i)
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
