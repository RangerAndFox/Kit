import { getAccessToken } from '../project-control/sheets'
import { getDropboxAccessToken } from '../dropbox/client'
import { readDocxComments, MAX_DOCX_BYTES } from './docx'
import type { FeedbackSource, FeedbackSnapshot, FeedbackComment } from './model'

export interface ProviderDeps {
  fetch: typeof fetch; googleToken(): Promise<string>; dropboxToken(): Promise<string>; figmaToken(): string | undefined
}
const defaults: ProviderDeps = {
  fetch: (...args) => fetch(...args), googleToken: getAccessToken, dropboxToken: getDropboxAccessToken,
  figmaToken: () => process.env.FIGMA_COMMENTS_TOKEN,
}
export class FeedbackError extends Error {
  constructor(public code: string, public retryAfterSeconds = 3600) { super(code) }
}
async function body(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel()
    const retry = Number(response.headers.get('retry-after'))
    throw new FeedbackError(`provider_http_${response.status}`, response.status === 429 && Number.isFinite(retry) ? Math.max(3600, retry) : 3600)
  }
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new FeedbackError('document_too_large') }
  const reader = response.body?.getReader()
  if (!reader) throw new FeedbackError('empty_provider_response')
  const chunks: Buffer[] = []; let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break
      size += value.length; if (size > limit) throw new FeedbackError('document_too_large')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}
async function json<T>(deps: ProviderDeps, url: string, init: RequestInit): Promise<T> {
  const r = await deps.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  return JSON.parse((await body(r, 5 * 1024 * 1024)).toString('utf8')) as T
}
function validate(snapshot: FeedbackSnapshot): FeedbackSnapshot {
  if (snapshot.comments.length > 500) throw new FeedbackError('too_many_comments')
  if (snapshot.comments.some(c => !c.id || c.text.length > 20_000)) throw new FeedbackError('invalid_comment_data')
  if (new Set(snapshot.comments.map(c => c.id)).size !== snapshot.comments.length) throw new FeedbackError('duplicate_source_comment_ids')
  return snapshot
}

/** All network destinations are fixed provider APIs. Never fetch a pasted URL
 * directly, follow a redirect, or forward credentials to document hyperlinks. */
export async function readFeedback(source: FeedbackSource, deps = defaults): Promise<FeedbackSnapshot> {
  if (source.provider === 'figma') {
    const token = deps.figmaToken()
    if (!token) throw new FeedbackError('figma_connection_required')
    const result = await json<{ comments: Array<{ id: string; parent_id?: string; message: string; created_at: string; resolved_at?: string | null; user?: { handle?: string }; client_meta?: { node_id?: string } }> }>(deps,
      `https://api.figma.com/v1/files/${encodeURIComponent(source.fileId)}/comments`, { headers: { 'X-Figma-Token': token } })
    if (!Array.isArray(result.comments)) throw new FeedbackError('invalid_provider_response')
    return validate({ title: source.label, comments: result.comments.map(c => ({
      id: c.id, parentId: c.parent_id || undefined, text: c.message, date: c.created_at,
      author: c.user?.handle || 'Unknown author', resolved: c.parent_id ? null : !!c.resolved_at,
      location: c.client_meta?.node_id ? `Figma node ${c.client_meta.node_id}` : undefined,
    })) })
  }
  if (source.provider === 'drive') {
    const token = await deps.googleToken()
    const headers = { Authorization: `Bearer ${token}` }
    const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(source.fileId)}`
    const file = await json<{ name: string; mimeType: string; size?: string; trashed?: boolean }>(deps, `${base}?fields=name,mimeType,size,trashed&supportsAllDrives=true`, { headers })
    if (file.trashed) throw new FeedbackError('source_deleted')
    const word = file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if (!word && file.mimeType !== 'application/vnd.google-apps.document') throw new FeedbackError('direct_document_link_required')
    const comments: FeedbackComment[] = []
    type DriveComment = { id: string; content?: string; createdTime?: string; resolved?: boolean; deleted?: boolean; author?: { displayName?: string }; quotedFileContent?: { value?: string }; replies?: DriveComment[] }
    let pageToken = ''
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ pageSize: '100', includeDeleted: 'true', fields: 'nextPageToken,comments(id,content,createdTime,resolved,deleted,author(displayName),quotedFileContent,replies(id,content,createdTime,deleted,author(displayName)))', ...(pageToken ? { pageToken } : {}) })
      const data = await json<{ comments?: DriveComment[]; nextPageToken?: string }>(deps, `${base}/comments?${q}`, { headers })
      for (const c of data.comments || []) {
        const convert = (r: DriveComment, parentId?: string): FeedbackComment => ({ id: `drive:${r.id}`, parentId,
          author: r.author?.displayName || 'Unknown author', text: r.content || '', date: r.createdTime || '', deleted: r.deleted,
          resolved: !!c.resolved, location: r.quotedFileContent?.value?.slice(0, 300) })
        comments.push(convert(c), ...(c.replies || []).map(r => convert(r, `drive:${c.id}`)))
      }
      if (comments.length > 500) throw new FeedbackError('too_many_comments')
      pageToken = data.nextPageToken || ''
      if (!pageToken) break
    }
    if (pageToken) throw new FeedbackError('comment_pagination_incomplete')
    if (word) {
      if (Number(file.size) > MAX_DOCX_BYTES) throw new FeedbackError('document_too_large')
      const response = await deps.fetch(`${base}?alt=media&supportsAllDrives=true`, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) })
      comments.push(...await readDocxComments(await body(response, MAX_DOCX_BYTES)))
    }
    return validate({ title: file.name, comments })
  }
  const token = await deps.dropboxToken()
  const meta = await json<{ name: string; '.tag': string; size?: number }>(deps, 'https://api.dropboxapi.com/2/sharing/get_shared_link_metadata', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: source.url }),
  })
  if (meta['.tag'] !== 'file' || !/\.docx$/i.test(meta.name)) throw new FeedbackError('direct_docx_link_required')
  if ((meta.size || 0) > MAX_DOCX_BYTES) throw new FeedbackError('document_too_large')
  const r = await deps.fetch('https://content.dropboxapi.com/2/sharing/get_shared_link_file', { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ url: source.url }) }, signal: AbortSignal.timeout(20_000) })
  return validate({ title: meta.name, comments: await readDocxComments(await body(r, MAX_DOCX_BYTES)) })
}

export function errorMessage(code: string): string {
  if (code === 'figma_connection_required') return 'Figma comment access is not connected. A read-only Figma connection is needed.'
  if (['provider_http_401','provider_http_403','provider_http_404','provider_http_409','source_deleted'].includes(code)) return 'Kit could not read this file. Check that it still exists and is shared with Kit. Previous comments may be stale.'
  if (code.includes('link_required')) return 'Use a direct Google Doc or .docx file link in Assets; folder links are not imported.'
  if (code === 'provider_http_429') return 'The source is rate-limiting Kit. A later retry is scheduled; previous comments may be stale.'
  return 'Comment sync could not finish. Previous comments are retained and may be stale; a retry is scheduled.'
}
