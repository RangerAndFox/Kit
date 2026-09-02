import { frameioHeaders } from './auth'
import { FRAMEIO_API_BASE, normalizeFrameioNextLink } from './url'

export interface FrameioProjectShare {
  id: string
  name: string
  url: string
  createdAt: string
}

function shareUrl(value: Record<string, unknown>): string {
  for (const key of ['short_url', 'url', 'share_url', 'view_url']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

/** Normalize the deliberately sparse and occasionally renamed v4 share fields. */
export function normalizeFrameioProjectShare(value: unknown): FrameioProjectShare | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  const url = shareUrl(row)
  if (!id || !url) return null
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Frame.io share'
  const createdAt = [row.created_at, row.inserted_at, row.created]
    .find((candidate) => typeof candidate === 'string' && candidate.trim())
  return { id, name, url, createdAt: typeof createdAt === 'string' ? createdAt : '' }
}

export function newestFrameioProjectShare(values: unknown[]): FrameioProjectShare | null {
  const shares = values.map(normalizeFrameioProjectShare).filter((share): share is FrameioProjectShare => Boolean(share))
  shares.sort((a, b) => {
    const aTime = Date.parse(a.createdAt)
    const bTime = Date.parse(b.createdAt)
    if (Number.isFinite(aTime) && Number.isFinite(bTime)) return bTime - aTime
    if (Number.isFinite(aTime)) return -1
    if (Number.isFinite(bTime)) return 1
    return 0
  })
  return shares[0] || null
}

/** List every public/review share in one Frame.io project. */
export async function listFrameioProjectShares(
  accountId: string,
  projectId: string,
  send: typeof fetch = fetch,
): Promise<FrameioProjectShare[]> {
  const headers = await frameioHeaders()
  const rows: unknown[] = []
  let path: string | null = `/accounts/${accountId}/projects/${projectId}/shares?page_size=100`
  let pages = 0
  while (path && pages++ < 20) {
    const response = await send(`${FRAMEIO_API_BASE}${path}`, { headers })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Frame.io ${path}: ${response.status} ${body}`)
    }
    const payload = await response.json() as Record<string, unknown>
    const data = payload.data || payload.shares || payload.items
    if (Array.isArray(data)) rows.push(...data)
    const links = payload.links && typeof payload.links === 'object' && !Array.isArray(payload.links)
      ? payload.links as Record<string, unknown>
      : null
    const next = links?.next ?? payload.next_page
    if (typeof next !== 'string' || !next.trim()) path = null
    else path = normalizeFrameioNextLink(next)
  }
  return rows.map(normalizeFrameioProjectShare).filter((share): share is FrameioProjectShare => Boolean(share))
}
