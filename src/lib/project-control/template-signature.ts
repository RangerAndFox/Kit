/**
 * Project Control template resolution by STRUCTURAL SIGNATURE.
 *
 * Provisioning clones every canvas tabbed to the template channel. Exactly one
 * of them is the Project Control Canvas; we identify it deterministically by its
 * structure rather than asking a human for a Slack file id. Zero or multiple
 * matches must fail closed (the caller stops only the Project Control binding
 * step and surfaces an actionable error).
 *
 * Signature (verified from the real R&F template):
 *   - metadata labels: Client, Contacts, Project Type, Producer, CD, Delivery, VO
 *   - an "Assets Folders" section
 *   - Dropbox and Frame.io asset labels
 *   - a "Milestones" section
 */

function norm(s: string): string {
  return s
    .replace(/!\[\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*`>_~:|.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const REQUIRED_LABELS = [
  'client',
  'contacts',
  'project type',
  'producer',
  'cd',
  'delivery',
  'vo',
  'dropbox',
  'frameio', // "Frame.io" normalizes to "frameio"
]

const REQUIRED_SECTIONS = ['assets folders', 'milestones']

interface Extracted {
  labels: Set<string>
  sections: Set<string>
}

function extract(markdown: string): Extracted {
  const labels = new Set<string>()
  const sections = new Set<string>()
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#')) {
      sections.add(norm(line))
      continue
    }
    if (line.startsWith('|') && line.endsWith('|')) {
      const first = line.slice(1, -1).split('|')[0]
      const n = norm(first)
      if (n) labels.add(n)
    }
  }
  return { labels, sections }
}

/** True when the markdown carries the full Project Control structural signature. */
export function hasProjectControlSignature(markdown: string): boolean {
  const { labels, sections } = extract(markdown)
  const hasLabels = REQUIRED_LABELS.every((l) => labels.has(l))
  const hasSections = REQUIRED_SECTIONS.every(
    (s) => sections.has(s) || [...sections].some((sec) => sec.includes(s)) || labels.has(s),
  )
  return hasLabels && hasSections
}

export interface TemplateCandidate {
  fileId: string
  markdown: string
}

export type TemplateResolution =
  | { ok: true; fileId: string; markdown: string }
  | { ok: false; reason: 'none' | 'multiple'; matchedFileIds: string[] }

/**
 * Resolve the single Project Control template.
 *
 * @param candidates canvases from the template channel, in production ordering.
 * @param configuredFileId when set (SLACK_PROJECT_CONTROL_TEMPLATE_FILE_ID),
 *        takes precedence and skips structural matching.
 */
export function resolveProjectControlTemplate(
  candidates: TemplateCandidate[],
  configuredFileId?: string,
): TemplateResolution {
  if (configuredFileId) {
    const pinned = candidates.find((c) => c.fileId === configuredFileId)
    if (pinned) return { ok: true, fileId: pinned.fileId, markdown: pinned.markdown }
    return { ok: false, reason: 'none', matchedFileIds: [] }
  }

  const matches = candidates.filter((c) => hasProjectControlSignature(c.markdown))
  if (matches.length === 1) return { ok: true, fileId: matches[0].fileId, markdown: matches[0].markdown }
  return {
    ok: false,
    reason: matches.length === 0 ? 'none' : 'multiple',
    matchedFileIds: matches.map((m) => m.fileId),
  }
}

export type ControlTemplateClassification =
  | { ok: true; fileId: string; markdown: string; cloneSafe: boolean }
  | { ok: false; reason: 'none' | 'multiple' | 'uncertain'; excludeFileIds: string[]; cloneSafe: boolean }

/**
 * Pure fail-closed classification over an already-fetched candidate set. Given
 * whether enumeration was PARTIAL, decides which candidates to exclude from a
 * generic clone and whether generic cloning is safe at all:
 *
 *   - exactly one match → ok (exclude it, clone the rest);
 *   - zero matches, full enumeration → clone the rest (none are control-like);
 *   - multiple matches, full enumeration → exclude ALL matches, clone the rest;
 *   - partial enumeration → uncertain, cloneSafe=false (clone nothing);
 *   - a configured id that failed to resolve → excluded AND cloneSafe=false
 *     (we could not verify it, so a control-like canvas might be unexcluded).
 */
export function classifyControlTemplate(
  candidates: TemplateCandidate[],
  partial: boolean,
  configuredFileId?: string,
): ControlTemplateClassification {
  const r = resolveProjectControlTemplate(candidates, configuredFileId)
  // Even a definitive single match must NOT trigger a generic clone when
  // enumeration was partial — an unread candidate could be control-like too.
  if (r.ok) return { ok: true, fileId: r.fileId, markdown: r.markdown, cloneSafe: !partial }
  const fail = r as Extract<TemplateResolution, { ok: false }>
  const excludeFileIds = Array.from(
    new Set([...fail.matchedFileIds, ...(configuredFileId ? [configuredFileId] : [])]),
  )
  const configuredButUnverified = !!configuredFileId
  const cloneSafe = !partial && !configuredButUnverified
  const reason: 'none' | 'multiple' | 'uncertain' = partial ? 'uncertain' : fail.reason
  return { ok: false, reason, excludeFileIds, cloneSafe }
}
