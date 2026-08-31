/** Return the Dropbox-style parent path for a project file. */
export function dropboxDirname(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const slash = normalized.lastIndexOf('/')
  return slash > 0 ? normalized.slice(0, slash) : '/'
}

/** Make a comp name safe for the shared render-output directory. */
export function sanitizeName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'comp'
}
