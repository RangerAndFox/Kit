// @ts-nocheck
/**
 * Normalize an incoming .aep path to the exact path the Deadline render nodes
 * read. Files live on the production SAN (e.g. \\thewire\production\...), which
 * some machines mount as a drive letter (Z:\...). DEADLINE_PATH_MAP rules
 * ("from=>to;...") map those to a UNC path every headless Worker resolves
 * (e.g. "Z:=>\\thewire\production"). UNC input with no matching rule passes
 * through unchanged. Longest matching prefix wins.
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

/** Dirname of a Windows/UNC path (handles both \ and /). */
export function farmDirname(p: string): string {
  const t = p.replace(/[\\/]+$/, '')
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'))
  return i < 0 ? '' : t.slice(0, i)
}

/** Basename of a Windows/UNC path. */
export function farmBasename(p: string): string {
  const t = p.replace(/[\\/]+$/, '')
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'))
  return i < 0 ? t : t.slice(i + 1)
}
