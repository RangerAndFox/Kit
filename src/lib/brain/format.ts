/**
 * Brain markdown format — parse / serialize / patch.
 *
 * A brain is structured markdown:
 *   - YAML-ish frontmatter between `---` fences
 *   - optional `# Brain — <title>` H1
 *   - `## <Section>` headings as the patch surface
 *   - bullets within sections, each ending in an HTML-comment provenance tag:
 *       - <text> <!-- src: <ref> conf: <0..1> by: <author> -->
 *
 * The serializer is deterministic so parse(serialize(parse(x))) === parse(x)
 * and round-trips of canonical input are byte-stable.
 *
 * Spec: KIT-BRAIN-SPEC.md §2.2
 */

export interface BrainProvenance {
  src?: string
  conf?: number
  by?: string
}

export interface BrainBullet {
  text: string
  provenance?: BrainProvenance
  checked?: boolean | null   // null = not a checkbox; true/false = `- [x]` / `- [ ]`
}

export interface BrainSection {
  heading: string
  preamble?: string          // free text between the heading and the first bullet
  bullets: BrainBullet[]
}

export interface BrainFrontmatter {
  brain_id: string
  scope: 'studio' | 'project'
  project_code?: string
  slack_channel?: string
  project_id?: string
  updated?: string
  revision?: number
  [k: string]: any
}

export interface Brain {
  frontmatter: BrainFrontmatter
  title?: string
  sections: BrainSection[]
}

// ─── Parse ─────────────────────────────────────────────────────────────────

const FRONTMATTER_FENCE = /^---\s*$/
const HEADING_H1 = /^#\s+(.*)$/
const HEADING_H2 = /^##\s+(.*)$/
const BULLET = /^\s*-\s+(.*)$/
const CHECKBOX_BULLET = /^\s*-\s+\[( |x|X)\]\s+(.*)$/
const PROVENANCE = /<!--\s*([\s\S]*?)\s*-->\s*$/

export function parseProvenanceComment(line: string): { text: string; provenance?: BrainProvenance } {
  const match = line.match(PROVENANCE)
  if (!match) return { text: line }
  const body = match[1]
  const prov: BrainProvenance = {}
  // Tokens: src: <ref>  conf: <n>  by: <author>
  // Each value is whitespace-terminated by the next key or end-of-string.
  const keyRe = /\b(src|conf|by)\s*:\s*/g
  const keys: Array<{ key: 'src' | 'conf' | 'by'; start: number; valueStart: number }> = []
  let m: RegExpExecArray | null
  while ((m = keyRe.exec(body)) !== null) {
    keys.push({ key: m[1] as 'src' | 'conf' | 'by', start: m.index, valueStart: m.index + m[0].length })
  }
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const end = i + 1 < keys.length ? keys[i + 1].start : body.length
    const value = body.slice(k.valueStart, end).trim()
    if (k.key === 'conf') {
      const n = Number(value)
      if (Number.isFinite(n)) prov.conf = n
    } else {
      prov[k.key] = value
    }
  }
  const cleaned = line.slice(0, match.index).replace(/\s+$/, '')
  const hasProv = prov.src !== undefined || prov.conf !== undefined || prov.by !== undefined
  return { text: cleaned, provenance: hasProv ? prov : undefined }
}

function parseFrontmatter(lines: string[]): { fm: BrainFrontmatter; consumed: number } {
  if (lines.length === 0 || !FRONTMATTER_FENCE.test(lines[0])) {
    return { fm: { brain_id: '', scope: 'project' }, consumed: 0 }
  }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_FENCE.test(lines[i])) {
      end = i
      break
    }
  }
  if (end === -1) {
    // No closing fence — treat as no frontmatter.
    return { fm: { brain_id: '', scope: 'project' }, consumed: 0 }
  }
  const fm: BrainFrontmatter = { brain_id: '', scope: 'project' }
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1).trim()
    if (!key) continue
    if (key === 'revision') {
      const n = Number(raw)
      fm.revision = Number.isFinite(n) ? n : 0
    } else if (key === 'scope') {
      fm.scope = (raw === 'studio' || raw === 'project') ? raw : 'project'
    } else {
      fm[key] = raw
    }
  }
  return { fm, consumed: end + 1 }
}

export function parseBrain(markdown: string): Brain {
  const lines = markdown.split(/\r?\n/)
  const { fm, consumed } = parseFrontmatter(lines)
  let i = consumed
  let title: string | undefined
  const sections: BrainSection[] = []
  let current: BrainSection | null = null

  while (i < lines.length) {
    const line = lines[i]
    const h1 = line.match(HEADING_H1)
    if (h1 && !current && !title) {
      title = h1[1].trim()
      i++
      continue
    }
    const h2 = line.match(HEADING_H2)
    if (h2) {
      current = { heading: h2[1].trim(), bullets: [] }
      sections.push(current)
      i++
      continue
    }
    if (!current) {
      // Lines before the first H2 outside frontmatter/title are ignored.
      i++
      continue
    }
    const checkbox = line.match(CHECKBOX_BULLET)
    if (checkbox) {
      const { text, provenance } = parseProvenanceComment(checkbox[2])
      current.bullets.push({
        checked: checkbox[1].toLowerCase() === 'x',
        text,
        provenance,
      })
      i++
      continue
    }
    const bullet = line.match(BULLET)
    if (bullet) {
      const { text, provenance } = parseProvenanceComment(bullet[1])
      current.bullets.push({ text, provenance, checked: null })
      i++
      continue
    }
    // Non-bullet, non-heading line inside a section becomes preamble (only
    // if it's before the first bullet).
    if (current.bullets.length === 0 && line.trim().length > 0) {
      current.preamble = current.preamble ? `${current.preamble}\n${line}` : line
    }
    i++
  }
  return { frontmatter: fm, title, sections }
}

// ─── Serialize ─────────────────────────────────────────────────────────────

function serializeProvenance(p?: BrainProvenance): string {
  if (!p) return ''
  const parts: string[] = []
  if (p.src !== undefined) parts.push(`src: ${p.src}`)
  if (p.conf !== undefined) parts.push(`conf: ${p.conf}`)
  if (p.by !== undefined) parts.push(`by: ${p.by}`)
  if (parts.length === 0) return ''
  return ` <!-- ${parts.join(' ')} -->`
}

function serializeBullet(b: BrainBullet): string {
  const prefix = b.checked === true ? '- [x] ' : b.checked === false ? '- [ ] ' : '- '
  return `${prefix}${b.text}${serializeProvenance(b.provenance)}`
}

function serializeFrontmatter(fm: BrainFrontmatter): string {
  const lines: string[] = ['---']
  // Stable key order so the file diff stays minimal.
  const ordered = ['brain_id', 'scope', 'project_code', 'project_id', 'slack_channel', 'updated', 'revision']
  for (const k of ordered) {
    const v = (fm as any)[k]
    if (v === undefined || v === null || v === '') continue
    lines.push(`${k}: ${v}`)
  }
  for (const k of Object.keys(fm)) {
    if (ordered.includes(k)) continue
    const v = (fm as any)[k]
    if (v === undefined || v === null || v === '') continue
    lines.push(`${k}: ${v}`)
  }
  lines.push('---')
  return lines.join('\n')
}

export function serializeBrain(brain: Brain): string {
  const parts: string[] = []
  parts.push(serializeFrontmatter(brain.frontmatter))
  parts.push('')
  if (brain.title) {
    parts.push(`# ${brain.title}`)
    parts.push('')
  }
  for (const s of brain.sections) {
    parts.push(`## ${s.heading}`)
    if (s.preamble) {
      parts.push(s.preamble)
    }
    for (const b of s.bullets) {
      parts.push(serializeBullet(b))
    }
    parts.push('')
  }
  // Trim trailing blank lines to a single newline at EOF.
  let out = parts.join('\n')
  out = out.replace(/\n+$/, '\n')
  return out
}

// ─── Patch helpers ─────────────────────────────────────────────────────────

export function findSection(brain: Brain, heading: string): BrainSection | undefined {
  const needle = heading.trim().toLowerCase()
  return brain.sections.find((s) => s.heading.toLowerCase() === needle)
}

export function ensureSection(brain: Brain, heading: string): BrainSection {
  const found = findSection(brain, heading)
  if (found) return found
  const created: BrainSection = { heading, bullets: [] }
  brain.sections.push(created)
  return created
}

export type PatchOp = 'add' | 'update' | 'supersede' | 'replace'

export interface BrainPatch {
  section: string
  operation: PatchOp
  text: string
  provenance?: BrainProvenance
  /** For update/supersede: the existing bullet text to match (substring, case-insensitive). */
  match?: string
  checked?: boolean | null
}

/**
 * Apply a patch in-place. Returns a short human-readable diff line. Used by
 * the Brain Writer (Phase 2) and the seed path (Phase 1).
 *
 * Whenever a real (non-system) bullet lands in a section, any "No X yet"
 * placeholder bullets (provenance.src === 'system') in that same section
 * are removed. Phase-1 seeds populate every section with a placeholder so
 * Haiku can patch against a stable anchor; once content arrives the
 * placeholder is no longer informative and just adds noise.
 */
export function applyPatch(brain: Brain, patch: BrainPatch): string {
  const section = ensureSection(brain, patch.section)
  const bullet: BrainBullet = {
    text: patch.text,
    provenance: patch.provenance,
    checked: patch.checked === undefined ? null : patch.checked,
  }
  const isSystemPatch = patch.provenance?.src === 'system'

  if (patch.operation === 'replace') {
    section.bullets = [bullet]
    return `replace § ${patch.section}: ${patch.text}`
  }
  if (patch.operation === 'add') {
    section.bullets.push(bullet)
    if (!isSystemPatch) stripSystemPlaceholders(section)
    return `add § ${patch.section}: ${patch.text}`
  }
  if (patch.operation === 'update' || patch.operation === 'supersede') {
    const idx = patch.match
      ? section.bullets.findIndex((b) => b.text.toLowerCase().includes(patch.match!.toLowerCase()))
      : -1
    if (idx >= 0) {
      if (patch.operation === 'update') {
        section.bullets[idx] = bullet
        if (!isSystemPatch) stripSystemPlaceholders(section)
        return `update § ${patch.section}: ${patch.text}`
      }
      // supersede: keep the old bullet, struck-through, append the new one
      const old = section.bullets[idx]
      section.bullets[idx] = { ...old, text: `~~${old.text}~~` }
      section.bullets.push(bullet)
      if (!isSystemPatch) stripSystemPlaceholders(section)
      return `supersede § ${patch.section}: ${patch.text}`
    }
    // No match — fall through to add.
    section.bullets.push(bullet)
    if (!isSystemPatch) stripSystemPlaceholders(section)
    return `add § ${patch.section}: ${patch.text}`
  }
  return ''
}

function stripSystemPlaceholders(section: BrainSection): void {
  if (section.bullets.length <= 1) return
  // Only strip if at least one real (non-system) bullet remains.
  const hasReal = section.bullets.some((b) => b.provenance?.src !== 'system')
  if (!hasReal) return
  section.bullets = section.bullets.filter((b) => b.provenance?.src !== 'system')
}

/**
 * Public helper: remove every "No X yet" placeholder from every section
 * that already has at least one real bullet. Used by the backfill script
 * that cleans Phase-1 brains created before the auto-strip logic landed.
 */
export function pruneSystemPlaceholders(brain: Brain): { removed: number } {
  let removed = 0
  for (const section of brain.sections) {
    const hasReal = section.bullets.some((b) => b.provenance?.src !== 'system')
    if (!hasReal) continue
    const before = section.bullets.length
    section.bullets = section.bullets.filter((b) => b.provenance?.src !== 'system')
    removed += before - section.bullets.length
  }
  return { removed }
}

/**
 * Strip provenance HTML comments — produces the "human" view of the brain
 * (e.g. for Slack canvas rendering). Headings, bullets, preamble preserved.
 */
export function stripProvenance(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/\s*<!--[\s\S]*?-->\s*$/, '').replace(/\s+$/, ''))
    .join('\n')
}

/**
 * Build a canonical brain id from a project code + slug. Pure — no I/O.
 */
export function buildBrainId(opts: { scope: 'studio' | 'project'; projectCode?: string; slug?: string }): string {
  if (opts.scope === 'studio') return 'studio'
  const code = (opts.projectCode || '').toLowerCase().replace(/[^a-z0-9-]/g, '')
  const slug = (opts.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')
  if (code && slug) return `proj-${code}-${slug}`
  if (code) return `proj-${code}`
  if (slug) return `proj-${slug}`
  return `proj-unknown-${Date.now()}`
}
