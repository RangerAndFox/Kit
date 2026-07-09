// @ts-nocheck
/**
 * Translate a Kit Dropbox path (e.g. "/Projects/Acme/Acme.aep") to the path the
 * Deadline render nodes actually read (a UNC share or mapped drive), using the
 * DEADLINE_PATH_MAP rules ("dropboxPrefix=>farmPrefix;..."). Longest matching
 * prefix wins. Forward slashes become backslashes for the Windows farm.
 */

import { config } from './config'

interface Rule {
  from: string
  to: string
}

function parseRules(): Rule[] {
  if (!config.pathMap) return []
  return config.pathMap
    .split(';')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [from, to] = r.split('=>').map((s) => s.trim())
      return { from, to }
    })
    .filter((r) => r.from && r.to)
    // Longest prefix first so the most specific rule wins.
    .sort((a, b) => b.from.length - a.from.length)
}

const RULES = parseRules()

export function toFarmPath(dropboxPath: string): string {
  const norm = dropboxPath.replace(/\\/g, '/')
  for (const rule of RULES) {
    const from = rule.from.replace(/\\/g, '/').replace(/\/+$/, '')
    if (norm === from || norm.startsWith(from + '/')) {
      const rest = norm.slice(from.length) // includes leading '/'
      const joined = rule.to.replace(/[\\/]+$/, '') + rest
      return joined.replace(/\//g, '\\')
    }
  }
  // No rule matched — return a backslash form and let the caller surface the
  // (likely) resolution failure with a clear message.
  return norm.replace(/\//g, '\\')
}

export function isMapped(dropboxPath: string): boolean {
  const norm = dropboxPath.replace(/\\/g, '/')
  return RULES.some((r) => {
    const from = r.from.replace(/\\/g, '/').replace(/\/+$/, '')
    return norm === from || norm.startsWith(from + '/')
  })
}

/** Dirname of a Dropbox path (posix semantics). */
export function dropboxDirname(p: string): string {
  const t = p.replace(/\/+$/, '')
  const i = t.lastIndexOf('/')
  return i <= 0 ? '' : t.slice(0, i)
}
