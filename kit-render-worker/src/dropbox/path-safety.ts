import * as path from 'node:path'

/** Resolve a Dropbox-style absolute path beneath a local sync root. */
export function resolvePathUnderRoot(root: string, dropboxPath: string): string | null {
  if (!root || !dropboxPath || dropboxPath.includes('\0')) return null
  const portable = dropboxPath.replace(/\\/g, '/')
  if (!portable.startsWith('/') || /^\/{2,}/.test(portable)) return null
  const segments = portable.split('/').filter(Boolean)
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..' || /^[a-z]:$/i.test(segment))) {
    return null
  }
  const absoluteRoot = path.resolve(root)
  const candidate = path.resolve(absoluteRoot, ...segments)
  const relative = path.relative(absoluteRoot, candidate)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return candidate
}
