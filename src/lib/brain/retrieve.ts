// @ts-nocheck
/**
 * Brain-first retrieval — when a question is asked in a channel that has
 * a brain, prefer brain sections for that channel over generic project
 * documents. Widens to general RAG when brain hits are sparse.
 *
 * Returns search results AND structured provenance refs so the
 * sourced-answer formatter can build a visible "Sources:" line.
 *
 * Spec: KIT-BRAIN-SPEC.md §3.4
 */

import { searchDocuments, type SearchResult } from '@/lib/rag/query'
import { createAdminClient } from '@/lib/supabase/admin'
import { parseBrain, type BrainBullet, type BrainProvenance } from './format'

export interface ProvenanceRef {
  src: string                   // e.g. "thread:C0123/p1718"
  section?: string              // e.g. "Operating context"
  brainId?: string
  by?: string
  confidence?: number
  /** The bullet text the source is attached to, for display. */
  text?: string
}

export interface BrainFirstResult {
  results: SearchResult[]
  brainResults: SearchResult[]
  generalResults: SearchResult[]
  /** Provenance refs collected from brain_section hits, in result order. */
  provenances: ProvenanceRef[]
  /** Brain row id when retrieval was scoped to a channel with a brain. */
  brainId: string | null
  /** Project id resolved from the channel, when available. */
  projectId: string | null
}

export interface RetrieveOpts {
  query: string
  channelId?: string | null
  workspaceId?: string | null
  /** Override brain selection (skip the channel lookup). */
  brainId?: string | null
  /** Total results to return after re-ranking. Default 10. */
  limit?: number
  /** Wider candidate pool before re-rank. Default = limit * 2. */
  candidatePool?: number
}

interface BrainRow {
  id: string
  project_id: string | null
  workspace_id: string
  markdown: string
}

async function resolveBrainForChannel(workspaceId: string, channelId: string): Promise<BrainRow | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('brains')
    .select('id, project_id, workspace_id, markdown')
    .eq('workspace_id', workspaceId)
    .eq('slack_channel', channelId)
    .maybeSingle()
  return (data as BrainRow) || null
}

async function getBrainRow(brainId: string): Promise<BrainRow | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('brains')
    .select('id, project_id, workspace_id, markdown')
    .eq('id', brainId)
    .maybeSingle()
  return (data as BrainRow) || null
}

/**
 * Brain-first search. Strategy:
 *   1. Resolve the brain for the channel (if any).
 *   2. Pull a wider candidate pool from match_documents — when a project_id
 *      is known, filter to that project to keep results focused.
 *   3. Partition: brain_section docs whose metadata.brain_id matches our
 *      brain → put first. Everything else → after.
 *   4. Trim to `limit`.
 *   5. For brain section results, parse the brain's markdown and pull the
 *      provenance from bullets in that section.
 *
 * When no brain is found, falls back to a plain searchDocuments call.
 */
export async function brainFirstRetrieve(opts: RetrieveOpts): Promise<BrainFirstResult> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10))
  const candidates = Math.max(limit, opts.candidatePool ?? limit * 2)

  // Step 1: resolve brain (if any)
  let brain: BrainRow | null = null
  if (opts.brainId) {
    brain = await getBrainRow(opts.brainId)
  } else if (opts.channelId && opts.workspaceId) {
    brain = await resolveBrainForChannel(opts.workspaceId, opts.channelId)
  }

  // Step 2: wide candidate pool. Filter by project when we have one — keeps
  // unrelated projects from polluting an in-channel answer. The studio brain
  // (scope=studio, no project_id) still surfaces because match_documents
  // returns rows with null project_id alongside scoped ones unless an
  // explicit filter is set.
  const projectId = brain?.project_id ?? null
  const rawResults = await searchDocuments(opts.query, {
    workspaceId: opts.workspaceId ?? null,
    projectId,
    limit: candidates,
  })

  // Step 3: partition + re-rank
  const brainResults: SearchResult[] = []
  const generalResults: SearchResult[] = []
  for (const r of rawResults) {
    const md = (r.metadata as any) || {}
    const isBrainHit =
      r.docType === 'brain_section' && (brain ? md.brain_id === brain.id : Boolean(md.brain_id))
    if (isBrainHit) brainResults.push(r)
    else generalResults.push(r)
  }
  const merged = [...brainResults, ...generalResults].slice(0, limit)

  // Step 4: extract provenance from brain section hits
  const provenances: ProvenanceRef[] = []
  if (brain) {
    const parsed = parseBrain(brain.markdown || '')
    const sectionByName = new Map(parsed.sections.map((s) => [s.heading.toLowerCase(), s]))
    for (const r of brainResults.slice(0, limit)) {
      const md = (r.metadata as any) || {}
      const sectionName = String(md.section || '').trim()
      if (!sectionName) continue
      const section = sectionByName.get(sectionName.toLowerCase())
      if (!section) continue
      // Surface the top few bullets from the section as candidate sources.
      // We don't (yet) re-rank within a section — Phase 4+ can score
      // bullet-level relevance. For Phase 3, sectioncoverage is enough.
      for (const bullet of section.bullets.slice(0, 4)) {
        const p = bulletToProvenanceRef(bullet, sectionName, brain.id)
        if (p) provenances.push(p)
      }
    }
  }

  return {
    results: merged,
    brainResults,
    generalResults,
    provenances: dedupeProvenance(provenances),
    brainId: brain?.id ?? null,
    projectId,
  }
}

function bulletToProvenanceRef(bullet: BrainBullet, sectionName: string, brainId: string): ProvenanceRef | null {
  const p: BrainProvenance | undefined = bullet.provenance
  if (!p?.src) return null
  // Skip system-authored bullets — they're placeholders, not real sources.
  if (p.src === 'system') return null
  return {
    src: p.src,
    section: sectionName,
    brainId,
    by: p.by,
    confidence: p.conf,
    text: bullet.text,
  }
}

function dedupeProvenance(refs: ProvenanceRef[]): ProvenanceRef[] {
  const seen = new Set<string>()
  const out: ProvenanceRef[] = []
  for (const r of refs) {
    const key = `${r.src}:${r.section || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

// ─── Sourced-answer formatter ──────────────────────────────────────────────

export interface SourcedContextOpts {
  /** Char budget for the context block. Defaults to 16k. */
  maxChars?: number
}

export interface SourcedContext {
  /** Prompt-ready context block (similar to buildContext, but tagged). */
  context: string
  /** Markdown-ready "Sources:" line for the answer footer. */
  sourcesLine: string
  /** Structured provenance for downstream UIs. */
  provenances: ProvenanceRef[]
}

/**
 * Build a context block + a Sources: line from a brainFirstRetrieve result.
 * The context block prefaces each chunk with [title · doc_type · similarity]
 * so the LLM can quote attribution back into its answer. The sourcesLine
 * is meant for the answer's bottom margin.
 */
export function buildSourcedContext(input: BrainFirstResult, opts: SourcedContextOpts = {}): SourcedContext {
  const maxChars = opts.maxChars ?? 16_000
  const parts: string[] = []
  let used = 0
  for (const r of input.results) {
    const block = `[${r.title}${r.docType ? ` · ${r.docType}` : ''}${r.similarity ? ` · ${r.similarity.toFixed(2)}` : ''}]\n${r.content}\n\n`
    if (used + block.length > maxChars) {
      const remaining = maxChars - used
      if (remaining > 200) parts.push(block.slice(0, remaining))
      break
    }
    parts.push(block)
    used += block.length
  }
  const context = parts.join('')
  const sourcesLine = formatSourcesLine(input.provenances)
  return { context, sourcesLine, provenances: input.provenances }
}

/**
 * Format the provenance refs as a single-line Slack-friendly Sources:
 * footer. Capped at 6 entries — anything beyond that is noise.
 */
export function formatSourcesLine(provenances: ProvenanceRef[]): string {
  if (provenances.length === 0) return ''
  const top = provenances.slice(0, 6)
  const entries = top.map((p) => {
    const section = p.section ? ` (${p.section})` : ''
    return `\`${p.src}\`${section}`
  })
  return `_Sources: ${entries.join(' · ')}_`
}
