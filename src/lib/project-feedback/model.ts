import { createHash } from 'node:crypto'
import { assetTypeKey, teamAssetLinks } from '../project-control/assets'

export type Provider = 'figma' | 'drive' | 'dropbox'
export interface FeedbackSource { key: string; provider: Provider; fileId: string; url: string; label: string }
export interface FeedbackComment {
  id: string; parentId?: string; author: string; text: string; date: string;
  resolved: boolean | null; location?: string; deleted?: boolean
}
export interface FeedbackSnapshot { title: string; comments: FeedbackComment[] }
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
// A short reference is visible in Slack; a DB unique index prevents collisions.
export const sectionMarker = (key: string) => `Kit-${key.slice(0, 12)}`

// These are the exact link types published in the team Overview. Never ingest
// arbitrary Other/budget links or follow links found inside source comments.
const TYPES = new Set(['figma', 'script', 'clientvisualreference', 'musicreference', 'dropbox', 'onedrive'])
export function parseSource(raw: string, label: string): FeedbackSource | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  let provider: Provider, fileId: string
  const figma = /^\/(?:design|file|proto|slides|board)\/([a-zA-Z0-9]+)(?:\/|$)/.exec(u.pathname)
  const drive = /^\/(?:document\/d|file\/d|drive\/folders)\/([\w-]+)(?:\/|$)/.exec(u.pathname)
  if (['figma.com', 'www.figma.com'].includes(u.hostname) && figma) {
    provider = 'figma'; fileId = figma[1]; u = new URL(`https://www.figma.com/design/${fileId}`)
  } else if (['docs.google.com', 'drive.google.com'].includes(u.hostname) && (drive || u.pathname === '/open')) {
    provider = 'drive'; fileId = drive?.[1] || u.searchParams.get('id') || ''
    if (!/^[\w-]+$/.test(fileId)) return null
    u = new URL(`https://drive.google.com/file/d/${fileId}/view`)
  } else if (['dropbox.com', 'www.dropbox.com'].includes(u.hostname) && /^\/(?:s|sh|scl\/(?:fi|fo))\//.test(u.pathname)) {
    provider = 'dropbox'; fileId = u.pathname
    const key = u.searchParams.get('rlkey')
    u.search = ''; if (key) u.searchParams.set('rlkey', key)
  } else return null
  return { provider, fileId, url: u.toString(), label, key: digest(`${provider}:${fileId}`) }
}

export function assetSources(links: Array<Record<string, string>>): FeedbackSource[] {
  const found = new Map<string, FeedbackSource>()
  for (const link of teamAssetLinks(links)) {
    const type = assetTypeKey(link['Link Type'] || '')
    if (!TYPES.has(type) || (link.Active || '').trim().toUpperCase() === 'FALSE') continue
    const source = parseSource((link.URL || '').trim(), link.Label || link['Link Type'])
    // The general Dropbox/OneDrive row is a project root, not permission to
    // crawl financial/admin subfolders. A Script folder instead gets a visible
    // direct-file-link requirement, never a misleading zero-comments result.
    if (source && ['dropbox','onedrive'].includes(type) && /\/(?:sh|scl\/fo|drive\/folders)\//.test(link.URL)) continue
    if (source) found.set(source.key, source)
  }
  return [...found.values()]
}

// Escape all imported prose: comments are untrusted data, never Slack mentions,
// Markdown instructions, arbitrary hyperlinks, or commands for an LLM.
export const text = (s: string) => s.replace(/Kit-[a-f0-9]{12}/gi, 'Kit reference').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}\[\]()#+.!|~]/g, '\\$&').replace(/\r?\n/g, '<br>')
export function pacificDate(s: string): string {
  const date = new Date(s)
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date)
}
export function renderFeedback(source: FeedbackSource, snapshot: FeedbackSnapshot | null, problem?: string): { heading: string; table: string } {
  const name = source.provider === 'figma' ? '🎨 Figma' : source.provider === 'dropbox' ? '📄 Word · Dropbox' : '📄 Document · Drive'
  const marker = sectionMarker(source.key)
  const rows: string[][] = []
  if (problem) rows.push(['⚠️ Sync status', text(problem), '—', '—'])
  const comments = [...(snapshot?.comments || [])].sort((a,b) => Number(a.resolved === true) - Number(b.resolved === true) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
  const roots = comments.filter(c => !c.parentId || !comments.some(p => p.id === c.parentId))
  let shown = 0, bytes = 0
  threads: for (const root of roots.slice(0, 40)) {
    for (const c of [root, ...comments.filter(c => c.parentId === root.id).reverse()].slice(0, 11)) {
      const line = [
        text(`${c.parentId ? '↳ Reply · ' : ''}${(c.author || 'Unknown author').slice(0, 160)}`),
        c.deleted ? 'Comment deleted at source' : text(c.text.length > 800 ? `${c.text.slice(0,800)}… [continued in original]` : c.text),
        text(`${pacificDate(c.date)}${c.location ? ` · ${c.location.slice(0, 300)}` : ''}`),
        c.resolved === null ? 'Unknown' : c.resolved ? '✅ Resolved' : '💬 Open',
      ]
      bytes += Buffer.byteLength(line.join(' | '))
      if (bytes > 25_000) break threads
      shown++; rows.push(line)
    }
  }
  if (comments.length > shown) rows.push(['More comments', `${comments.length - shown} additional comments are available in the original file.`, 'Open original below', '—'])
  if (!rows.length) rows.push(['—', 'No comments found in the latest successful read.', '—', '—'])
  // A single table is one replaceable Slack section. The marker is only in the
  // header, never in imported prose. A separate H3 is independently reconciled.
  return {
    heading: `### ${name} — ${text((snapshot?.title || source.label).slice(0, 200))} · ${marker}`,
    table: `| Author · ${marker} | Comment | Date / location | Status |\n| --- | --- | --- | --- |\n` +
      rows.map(r => `| ${r.join(' | ')} |`).join('\n') +
      `\n| Source | [Open original](${source.url.replace(/\(/g, '%28').replace(/\)/g, '%29')}) | Kit-managed comments; add team notes outside this table. | — |`,
  }
}
