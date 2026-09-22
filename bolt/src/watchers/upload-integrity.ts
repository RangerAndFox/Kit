export const SOURCE_QUIET_MS = 60_000

export type SourceIdentity = { dropboxId: string; rev: string; sizeBytes?: number; firstSeenAt?: string }
export type DropboxMetadata = { id: string; rev: string; size: number; server_modified: string }

export function sourceReadiness(expected: SourceIdentity, current: DropboxMetadata, now = Date.now()): 'ready' | 'wait' | 'superseded' {
  if (!expected.dropboxId.startsWith('id:') || !/^[0-9a-f]{9,}$/.test(expected.rev)) {
    throw new Error('Upload source is missing a valid Dropbox identity/revision')
  }
  if (current.id !== expected.dropboxId) throw new Error('Dropbox source identity mismatch')
  if (current.rev !== expected.rev) return 'superseded'
  if (!Number.isSafeInteger(current.size) || current.size <= 0) return 'wait'
  if (expected.sizeBytes !== undefined && current.size !== expected.sizeBytes) throw new Error('Dropbox revision size mismatch')
  const modified = Date.parse(current.server_modified)
  const observed = Date.parse(expected.firstSeenAt || '')
  if (!Number.isFinite(modified) || !Number.isFinite(observed) ||
    now - Math.max(modified, observed) < SOURCE_QUIET_MS) return 'wait'
  return 'ready'
}

export function assertExactSource(expected: SourceIdentity, source: DropboxMetadata): number {
  if (source.id !== expected.dropboxId || source.rev !== expected.rev ||
    !Number.isSafeInteger(source.size) || source.size <= 0 ||
    (expected.sizeBytes !== undefined && source.size !== expected.sizeBytes)) {
    throw new Error('Dropbox download source does not match the queued revision and size')
  }
  return source.size
}

function mediaFamily(name: string): string | null {
  if (/\.(mp4|mov|m4v|webm|avi|mxf|mpg|mpeg)$/i.test(name)) return 'video/'
  if (/\.(mp3|wav|aif|aiff|m4a|aac|flac|ogg)$/i.test(name)) return 'audio/'
  if (/\.(png|jpg|jpeg|gif|webp|tif|tiff|bmp)$/i.test(name)) return 'image/'
  return null
}

function matchesFamily(name: string, type: string, family: string): boolean {
  return type.startsWith(family) ||
    (/\.mxf$/i.test(name) && type === 'application/mxf') ||
    (/\.ogg$/i.test(name) && type === 'application/ogg') ||
    (/\.m4a$/i.test(name) && type === 'video/mp4')
}

export function assertSourceContentType(name: string, contentType: string): void {
  const type = contentType.split(';')[0].trim().toLowerCase()
  if (!type || type === 'application/octet-stream' || type === 'binary/octet-stream') return
  const family = mediaFamily(name)
  if ((family && !matchesFamily(name, type, family)) ||
    (type === 'application/json' && !/\.json$/i.test(name)) ||
    (type === 'text/html' && !/\.html?$/i.test(name))) {
    throw new Error(`Upload integrity: ${name} was served as ${type}, not the expected media`)
  }
}

/** Probe only Dropbox's generated URL, never an arbitrary stored URL. */
export async function verifySourceLink(url: string, name: string, size: number): Promise<void> {
  let current = url
  let response: Response | undefined
  for (let redirects = 0; redirects <= 3; redirects++) {
    const parsed = new URL(current)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      (parsed.port && parsed.port !== '443') || !parsed.hostname.endsWith('.dropboxusercontent.com')) {
      throw new Error('Unexpected Dropbox download host')
    }
    response = await fetch(current, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (!location) throw new Error('Dropbox download redirect has no destination')
    current = new URL(location, current).toString()
  }
  if (!response?.ok) throw new Error(`Dropbox download preflight failed (${response?.status})`)
  assertSourceContentType(name, response.headers.get('content-type') || '')
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) !== size) throw new Error('Dropbox download preflight size mismatch')
}

export function frameFileReadiness(file: Record<string, unknown>, expected: {
  id: string; folderId: string; projectId: string; name: string; size: number
}): 'ready' | 'processing' {
  if (file.id !== expected.id || file.parent_id !== expected.folderId || file.project_id !== expected.projectId) {
    throw new Error('Upload integrity: Frame.io file identity or destination mismatch')
  }
  if (!Number.isSafeInteger(expected.size) || expected.size <= 0 || file.file_size !== expected.size) {
    throw new Error('Upload integrity: Frame.io file size does not match the Dropbox source')
  }
  const type = String(file.media_type || '').split(';')[0].toLowerCase()
  const family = mediaFamily(expected.name)
  if (!type || (family && !matchesFamily(expected.name, type, family))) throw new Error('Upload integrity: Frame.io media type does not match the source')
  assertSourceContentType(expected.name, type)
  const status = String(file.status || '').toLowerCase()
  if (['failed', 'error', 'transcode_failed', 'canceled', 'cancelled'].includes(status)) throw new Error('Upload integrity: Frame.io media processing failed')
  // Transfer completion is not media readiness. Video/audio must finish transcoding.
  if (family === 'video/' || family === 'audio/') return status === 'transcoded' ? 'ready' : 'processing'
  // Documents/sidecars have no playable rendition. The caller has already
  // verified upload_complete; identity, exact bytes and MIME still apply.
  if (!family && ['created', 'uploaded'].includes(status)) return 'ready'
  return ['transcoded', 'ready', 'completed', 'complete', 'processed'].includes(status) ? 'ready' : 'processing'
}
