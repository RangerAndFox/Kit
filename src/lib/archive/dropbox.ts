import { dropboxRpc } from '../dropbox/client'
import { archiveFolderName, type ArchiveProjectSnapshot } from './types'

const VIDEO_RE = /\.(mp4|mov|m4v)$/i
const IMAGE_RE = /\.(png|jpe?g|webp)$/i
const GIF_RE = /\.gif$/i

interface DropboxVideoMetadata {
  '.tag'?: string
  id?: string
  name?: string
  size?: number
  path_lower?: string
  path_display?: string
  server_modified?: string
}

export interface DropboxArchiveFile {
  id: string
  path: string
  name: string
  size: number
  modified: string
}

async function listAll(path: string, recursive: boolean): Promise<any[]> {
  const first = await dropboxRpc('/files/list_folder', { path, recursive, include_deleted: false, limit: 200 }, 20_000)
  const entries = [...(first.entries || [])]
  let cursor = first.cursor
  let hasMore = !!first.has_more
  for (let page = 0; hasMore && page < 20; page++) {
    const next = await dropboxRpc('/files/list_folder/continue', { cursor }, 20_000)
    entries.push(...(next.entries || []))
    cursor = next.cursor
    hasMore = !!next.has_more
  }
  if (hasMore) throw new Error(`Dropbox listing exceeded the 20-page safety limit for ${path}; archive is incomplete.`)
  return entries
}

export async function findDeliveryVideos(projectPath: string): Promise<DropboxArchiveFile[]> {
  if (!projectPath) return []
  const deliveryPath = `${projectPath.replace(/\/$/, '')}/09_Outgoing/02_Delivery`
  try {
    const entries = await listAll(deliveryPath, true)
    return entries
      .filter((entry) => entry['.tag'] === 'file' && VIDEO_RE.test(entry.name || ''))
      .map((entry) => ({ id: entry.id, path: entry.path_display || entry.path_lower, name: entry.name, size: Number(entry.size || 0), modified: entry.server_modified || '' }))
      .sort((a, b) => b.modified.localeCompare(a.modified))
  } catch (error: any) {
    if (/path\/not_found|not_found/i.test(error?.message || '')) return []
    throw error
  }
}

export async function validateDropboxVideo(path: string): Promise<DropboxArchiveFile> {
  let source = (path || '').trim()
  // Slack sometimes wraps pasted links as <url|label>. Resolve links using
  // Dropbox's authenticated metadata API, never by fetching an arbitrary URL.
  const wrapped = /^<(https:\/\/[^|>]+)(?:\|[^>]*)?>$/.exec(source)
  if (wrapped) source = wrapped[1].replace(/&amp;/g, '&')
  if (!source) throw new Error('Paste a Dropbox link or full path to an MP4, MOV, or M4V file.')
  if (/^https?:\/\//i.test(source)) {
    let url: URL
    try { url = new URL(source) } catch { throw new Error('Paste a valid Dropbox file link.') }
    if (url.protocol !== 'https:' || !['dropbox.com', 'www.dropbox.com', 'dl.dropboxusercontent.com'].includes(url.hostname) ||
      url.username || url.password || url.port) throw new Error('Use an HTTPS Dropbox file link or a full Dropbox path.')
    let linked: DropboxVideoMetadata
    try { linked = await dropboxRpc('/sharing/get_shared_link_metadata', { url: url.toString() }, 20_000) }
    catch { throw new Error('Kit could not read that Dropbox link. Check its access, or paste the full Dropbox path instead.') }
    if (linked['.tag'] !== 'file') throw new Error('That Dropbox link points to a folder. Paste a link to the video file itself.')
    if (!VIDEO_RE.test(linked.name || '')) throw new Error('That Dropbox file is not an MP4, MOV, or M4V video.')
    source = linked.id || linked.path_lower || ''
    if (!source) throw new Error('Kit can view that link but cannot access its file in the connected Dropbox. Paste the file’s full Dropbox path.')
  } else if (!source.startsWith('/') && !source.startsWith('id:')) {
    throw new Error('Paste a Dropbox file link or the full path starting with /.')
  }
  let entry: DropboxVideoMetadata
  try { entry = await dropboxRpc('/files/get_metadata', { path: source, include_media_info: true }, 20_000) }
  catch { throw new Error('Kit could not access this file in the connected Dropbox. Check the link or path and try again.') }
  if (entry['.tag'] !== 'file') throw new Error('The selected Dropbox source is not a file.')
  if (!VIDEO_RE.test(entry.name || '')) throw new Error('The selected Dropbox file must be an MP4, MOV, or M4V video.')
  if (!Number.isFinite(Number(entry.size)) || Number(entry.size) < 1024) throw new Error('The video is empty or too small to archive. Wait for its export and Dropbox sync to finish.')
  const resolvedPath = entry.path_display || entry.path_lower || entry.id
  if (!resolvedPath || !entry.id) throw new Error('Dropbox did not return a usable file identity. Try the full Dropbox path.')
  return { id: entry.id, path: resolvedPath, name: entry.name || '', size: Number(entry.size), modified: entry.server_modified || '' }
}

async function ensureFolder(path: string): Promise<void> {
  try {
    await dropboxRpc('/files/create_folder_v2', { path, autorename: false }, 20_000)
  } catch (error: any) {
    if (!/conflict|already_exists/i.test(error?.message || '')) throw error
  }
}

async function copyIfMissing(source: string, destination: string): Promise<void> {
  try {
    await dropboxRpc('/files/copy_v2', { from_path: source, to_path: destination, autorename: false }, 60_000)
  } catch (error: any) {
    if (!/conflict/i.test(error?.message || '')) throw error
    // A name conflict is not proof of idempotency. Only reuse the destination
    // when Dropbox proves it contains the same bytes as the approved source.
    const [sourceMeta, destinationMeta] = await Promise.all([
      dropboxRpc('/files/get_metadata', { path: source }, 20_000),
      dropboxRpc('/files/get_metadata', { path: destination }, 20_000),
    ])
    const sameHash = sourceMeta.content_hash && destinationMeta.content_hash &&
      sourceMeta.content_hash === destinationMeta.content_hash
    const sameIdentity = sourceMeta.id && destinationMeta.id && sourceMeta.id === destinationMeta.id
    if (!sameHash && !sameIdentity) {
      throw new Error(`Dropbox archive destination already exists with different content: ${destination}`)
    }
  }
}

export async function prepareDropboxArchive(snapshot: ArchiveProjectSnapshot, source: DropboxArchiveFile): Promise<{
  folderPath: string
  videoPath: string
  media: DropboxArchiveFile[]
}> {
  const root = (process.env.KIT_ARCHIVE_ROOT || '/production/_ProjectArchive/01_Website/01_Projects').replace(/\/$/, '')
  const folderPath = `${root}/${archiveFolderName(snapshot)}`
  const videoDir = `${folderPath}/01_Video`
  const stillsDir = `${folderPath}/02_Stills`
  const processDir = `${stillsDir}/Process`
  const gifsDir = `${folderPath}/03_Gifs`
  for (const path of [folderPath, videoDir, stillsDir, processDir, gifsDir]) await ensureFolder(path)

  const ext = source.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '.mp4'
  const videoPath = `${videoDir}/${archiveFolderName(snapshot)}_Video_01${ext}`
  await copyIfMissing(source.path, videoPath)
  const entries = await listAll(folderPath, true)
  const media = entries
    .filter((entry) => entry['.tag'] === 'file' && (IMAGE_RE.test(entry.name || '') || GIF_RE.test(entry.name || '')))
    .map((entry) => ({ id: entry.id, path: entry.path_display || entry.path_lower, name: entry.name, size: Number(entry.size || 0), modified: entry.server_modified || '' }))
  return { folderPath, videoPath, media }
}

export async function listArchiveMedia(folderPath: string): Promise<DropboxArchiveFile[]> {
  const entries = await listAll(folderPath, true)
  return entries
    .filter((entry) => entry['.tag'] === 'file' && (IMAGE_RE.test(entry.name || '') || GIF_RE.test(entry.name || '')))
    .map((entry) => ({ id: entry.id, path: entry.path_display || entry.path_lower, name: entry.name, size: Number(entry.size || 0), modified: entry.server_modified || '' }))
}

export async function getDropboxTemporaryLink(path: string): Promise<string> {
  const result = await dropboxRpc('/files/get_temporary_link', { path }, 20_000)
  if (!result.link) throw new Error('Dropbox did not return a temporary download link.')
  return result.link
}

export async function getDropboxSharedLink(path: string): Promise<string | null> {
  try {
    const existing = await dropboxRpc('/sharing/list_shared_links', { path, direct_only: true }, 20_000)
    if (existing.links?.[0]?.url) return existing.links[0].url
    const created = await dropboxRpc('/sharing/create_shared_link_with_settings', {
      path,
      settings: { requested_visibility: 'team_only', audience: 'team', access: 'viewer', allow_download: true },
    }, 20_000)
    return created.url || null
  } catch {
    // Archive creation must not fail merely because team-link creation is blocked.
    return null
  }
}
