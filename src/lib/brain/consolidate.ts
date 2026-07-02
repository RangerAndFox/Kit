// @ts-nocheck
/**
 * Brain Consolidator — Phase 6.
 *
 * The nightly cron that keeps the brain tight as it ages. Three deterministic
 * checks + one optional Haiku dedupe pass:
 *
 *   1. Age-out Watchlist (deadlines & risks) — items dated more than N days
 *      in the past get removed (they're either resolved or stale).
 *
 *   2. Compress Recent decisions (log) — keep the most-recent N entries
 *      verbatim; older entries get moved into a "## Earlier decisions"
 *      section as a single condensed bullet (Haiku) so the brain stays
 *      readable but nothing is lost.
 *
 *   3. Dedupe within section (optional Haiku pass) — for sections with
 *      more than M bullets, ask Haiku to identify near-duplicates and
 *      merge them. Skipped when no ANTHROPIC_API_KEY.
 *
 * Replaces the heavy nightly re-summarize that used to run as
 * studioKnowledgeAutoSummarize for brain channels (project_summary docs
 * for unbrained projects still ride that path).
 *
 * Spec: KIT-BRAIN-SPEC.md §3.0 (consolidator), §7 (Phase 6)
 */

import Anthropic from '@anthropic-ai/sdk'
import {
  type Brain,
  type BrainBullet,
  type BrainSection,
  parseBrain,
  serializeBrain,
  ensureSection,
} from './format'
import { parseDateFromBullet } from './flagger'
import { embedBrainSections } from './store'
import { createAdminClient } from '@/lib/supabase/admin'

// ─── Tunables ──────────────────────────────────────────────────────────────

export const DEFAULTS = {
  /** Watchlist items >N days past due get removed. */
  watchlistGraceDays: 7,
  /** Recent decisions log: keep the most-recent N entries verbatim. */
  decisionsKeepRecent: 20,
  /** Dedupe Haiku pass only triggers when a section has more than this many bullets. */
  dedupeThreshold: 10,
} as const

const WATCHLIST_SECTIONS = new Set([
  'Watchlist (deadlines & risks)',
  'Watchlist',
])
const DECISIONS_LOG_SECTION = 'Recent decisions (log)'
const EARLIER_DECISIONS_SECTION = 'Earlier decisions'

// ─── Deterministic checks ──────────────────────────────────────────────────

export interface AgeOutOpts {
  graceDays?: number
  now?: Date
}

/**
 * Remove Watchlist bullets whose parsed date is more than `graceDays`
 * days in the past. Bullets without a parseable date are left alone
 * (they might be open-ended risks).
 *
 * Returns the bullets that were removed (for audit) and the count.
 */
export function ageOutWatchlist(brain: Brain, opts: AgeOutOpts = {}): { removed: BrainBullet[]; section?: BrainSection } {
  const graceDays = opts.graceDays ?? DEFAULTS.watchlistGraceDays
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - graceDays)
  const removed: BrainBullet[] = []
  let touched: BrainSection | undefined
  for (const section of brain.sections) {
    if (!WATCHLIST_SECTIONS.has(section.heading)) continue
    const next: BrainBullet[] = []
    for (const bullet of section.bullets) {
      // Never reap system placeholders or undated bullets here — only
      // dated items past the grace window get removed.
      if (bullet.provenance?.src === 'system') {
        next.push(bullet)
        continue
      }
      const date = parseDateFromBullet(bullet.text, now)
      if (date && date.getTime() < cutoff.getTime()) {
        removed.push(bullet)
        continue
      }
      next.push(bullet)
    }
    if (removed.length > 0) {
      section.bullets = next
      touched = section
    }
  }
  return { removed, section: touched }
}

export interface CompressOpts {
  keepRecent?: number
  now?: Date
}

/**
 * Move all but the most-recent `keepRecent` decisions out of the live
 * log into an `## Earlier decisions` section. The summary line for
 * each moved bullet keeps its provenance so `/kit brain why` still
 * works.
 *
 * Returns the count of bullets moved.
 */
export function compressDecisionsLog(brain: Brain, opts: CompressOpts = {}): { moved: number } {
  const keep = opts.keepRecent ?? DEFAULTS.decisionsKeepRecent
  const log = brain.sections.find((s) => s.heading === DECISIONS_LOG_SECTION)
  if (!log) return { moved: 0 }
  const real = log.bullets.filter((b) => b.provenance?.src !== 'system')
  if (real.length <= keep) return { moved: 0 }
  // Heuristic: bullets in the log are appended in chronological order, so
  // the OLDEST are at the front. Move all but the last `keep`.
  const sorted = sortBulletsByLeadingDate(real)
  const toMove = sorted.slice(0, real.length - keep)
  const toKeep = sorted.slice(real.length - keep)
  const earlier = ensureSection(brain, EARLIER_DECISIONS_SECTION)
  for (const bullet of toMove) earlier.bullets.push(bullet)
  // Preserve any system placeholder in the live log, then the kept real bullets.
  const placeholders = log.bullets.filter((b) => b.provenance?.src === 'system')
  log.bullets = [...placeholders, ...toKeep]
  return { moved: toMove.length }
}

/**
 * Sort bullets by a leading ISO date if present (e.g. "2026-05-30: foo"),
 * otherwise keep them in insertion order. Stable.
 */
function sortBulletsByLeadingDate(bullets: BrainBullet[]): BrainBullet[] {
  const decorated = bullets.map((b, i) => ({ b, i, date: leadingDate(b.text) }))
  decorated.sort((a, c) => {
    if (a.date && c.date) return a.date - c.date
    if (a.date) return -1
    if (c.date) return 1
    return a.i - c.i
  })
  return decorated.map((d) => d.b)
}

function leadingDate(text: string): number | null {
  const m = text.match(/^(?:~~)?(\d{4})-(\d{2})-(\d{2})\b/)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

// ─── Haiku dedupe pass ─────────────────────────────────────────────────────

interface DedupeProposal {
  /** Indices to KEEP (relative to the input bullets list). */
  keep: number[]
  /** Indices to MERGE into another keeper. */
  mergePairs: Array<{ from: number; into: number }>
  summary?: string
}

const DEDUPE_SYSTEM_PROMPT = `You are the Brain Consolidator for Ranger & Fox. Given a list of bullets from one section of a project brain, identify near-duplicates and propose a minimal-loss dedupe.

You output JSON ONLY in this exact shape:
{
  "keep": [<indices to keep>],
  "merge": [{"from": <duplicate index>, "into": <keeper index>}],
  "summary": "<one short sentence on what changed (or 'no duplicates found')>"
}

RULES:
- Only flag bullets that are SEMANTICALLY duplicate — same fact, same value, same date.
- Differently-phrased bullets that carry DIFFERENT facts are NOT duplicates. Leave them.
- Struck-through bullets (text starts with ~~) are historical records — never remove them.
- System placeholders (text starts with "No X yet") — never remove them.
- Bullets with different provenance tags but the same fact ARE duplicates — keep the one with HIGHER confidence (you'll see it in the input).
- When in doubt, KEEP. False positives erode trust.
- If no duplicates exist, return {"keep": [0,1,...,N-1], "merge": [], "summary": "no duplicates found"}.`

export interface DedupeOpts {
  bulletsThreshold?: number
}

/**
 * Run a Haiku pass over sections that exceed the dedupe threshold. Mutates
 * the brain in place. Skipped silently when no ANTHROPIC_API_KEY (the brain
 * still consolidates via the deterministic checks).
 */
export async function dedupeBullets(brain: Brain, opts: DedupeOpts = {}): Promise<{ sections_examined: number; duplicates_removed: number }> {
  const threshold = opts.bulletsThreshold ?? DEFAULTS.dedupeThreshold
  const apiKey = process.env.ANTHROPIC_API_KEY
  let sectionsExamined = 0
  let duplicatesRemoved = 0
  if (!apiKey) return { sections_examined: 0, duplicates_removed: 0 }
  const client = new Anthropic({ apiKey })

  for (const section of brain.sections) {
    if (section.bullets.length < threshold) continue
    sectionsExamined++
    const userPrompt = buildDedupePrompt(section)
    let proposal: DedupeProposal
    try {
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: DEDUPE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      })
      const text = res.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
      const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()
      const parsed = JSON.parse(cleaned)
      proposal = {
        keep: Array.isArray(parsed.keep) ? parsed.keep.filter((n: any) => Number.isInteger(n)) : [],
        mergePairs: Array.isArray(parsed.merge) ? parsed.merge.filter(validMergePair) : [],
        summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      }
    } catch (err: any) {
      console.error(`[brain.consolidate] dedupe of ${section.heading} failed:`, err?.message || err)
      continue
    }
    if (proposal.mergePairs.length === 0) continue
    const before = section.bullets.length
    section.bullets = applyDedupe(section.bullets, proposal)
    duplicatesRemoved += before - section.bullets.length
  }
  return { sections_examined: sectionsExamined, duplicates_removed: duplicatesRemoved }
}

function validMergePair(p: any): boolean {
  return Number.isInteger(p?.from) && Number.isInteger(p?.into) && p.from !== p.into
}

function buildDedupePrompt(section: BrainSection): string {
  const lines = section.bullets.map((b, i) => {
    const conf = b.provenance?.conf != null ? ` [conf:${b.provenance.conf}]` : ''
    const src = b.provenance?.src ? ` [src:${b.provenance.src}]` : ''
    return `${i}: ${b.text}${conf}${src}`
  })
  return `Section heading: ${section.heading}

Bullets:
${lines.join('\n')}

Identify duplicates per the rules. Output JSON only.`
}

function applyDedupe(bullets: BrainBullet[], proposal: DedupeProposal): BrainBullet[] {
  const removeIdx = new Set<number>()
  for (const p of proposal.mergePairs) {
    // Never remove a system placeholder via the dedupe pass
    if (bullets[p.from]?.provenance?.src === 'system') continue
    // Never remove a struck-through bullet
    if (/^~~/.test(bullets[p.from]?.text || '')) continue
    if (p.from < 0 || p.from >= bullets.length) continue
    removeIdx.add(p.from)
  }
  return bullets.filter((_, i) => !removeIdx.has(i))
}

// ─── Driver ────────────────────────────────────────────────────────────────

export interface ConsolidateOpts {
  graceDays?: number
  keepRecent?: number
  dedupeThreshold?: number
  now?: Date
}

export interface ConsolidateResult {
  brainId: string
  newRevision: number
  watchlist_removed: number
  decisions_moved: number
  sections_examined: number
  duplicates_removed: number
  skipped?: string
}

/**
 * Consolidate one brain by id. Loads markdown, runs all three checks +
 * optional Haiku dedupe, writes back the new markdown and bumps the
 * revision. Returns a result summary.
 */
export async function consolidateBrain(brainId: string, opts: ConsolidateOpts = {}): Promise<ConsolidateResult> {
  const sb = createAdminClient()
  const { data: row, error } = await sb
    .from('brains')
    .select('id, workspace_id, project_id, revision, markdown')
    .eq('id', brainId)
    .maybeSingle()
  if (error) throw new Error(`consolidateBrain: ${error.message}`)
  if (!row) return { brainId, newRevision: 0, watchlist_removed: 0, decisions_moved: 0, sections_examined: 0, duplicates_removed: 0, skipped: 'not_found' }

  const brain = parseBrain(row.markdown || '')
  const aged = ageOutWatchlist(brain, { graceDays: opts.graceDays, now: opts.now })
  const compressed = compressDecisionsLog(brain, { keepRecent: opts.keepRecent, now: opts.now })
  const deduped = await dedupeBullets(brain, { bulletsThreshold: opts.dedupeThreshold })

  const totalChanges = aged.removed.length + compressed.moved + deduped.duplicates_removed
  if (totalChanges === 0) {
    return {
      brainId,
      newRevision: row.revision,
      watchlist_removed: 0,
      decisions_moved: 0,
      sections_examined: deduped.sections_examined,
      duplicates_removed: 0,
      skipped: 'no_changes',
    }
  }

  const newRevision = (row.revision || 0) + 1
  brain.frontmatter.revision = newRevision
  brain.frontmatter.updated = new Date().toISOString()
  const markdown = serializeBrain(brain)

  // Optimistic concurrency — same guard as applyPatches. Without it, the
  // consolidator racing a message-driven applyPatches overwrote the writer's
  // patches wholesale (only one side of that race was guarded). On conflict,
  // skip this run; tonight's changes get picked up by the next nightly pass.
  const { data: updated, error: updErr } = await sb
    .from('brains')
    .update({ markdown, revision: newRevision, updated_at: new Date().toISOString() })
    .eq('id', brainId)
    .eq('revision', row.revision ?? 0)
    .select('id')
  if (updErr) throw new Error(`consolidateBrain: update failed: ${updErr.message}`)
  if (!updated || updated.length === 0) {
    return {
      brainId,
      newRevision: row.revision,
      watchlist_removed: 0,
      decisions_moved: 0,
      sections_examined: deduped.sections_examined,
      duplicates_removed: 0,
      skipped: 'revision_conflict',
    }
  }

  await sb.from('brain_revisions').insert({
    brain_id: brainId,
    revision: newRevision,
    operation: 'replace',
    diff: `consolidate: ${aged.removed.length} aged-out, ${compressed.moved} compressed, ${deduped.duplicates_removed} deduped`,
    author: 'system:consolidate',
  })

  // Re-embed so retrieval doesn't keep serving aged-out/deduped bullets as
  // stale brain_section docs (null = all sections; upsert is idempotent).
  await embedBrainSections(row.workspace_id, brainId, row.project_id ?? null, brain, null)

  return {
    brainId,
    newRevision,
    watchlist_removed: aged.removed.length,
    decisions_moved: compressed.moved,
    sections_examined: deduped.sections_examined,
    duplicates_removed: deduped.duplicates_removed,
  }
}

export async function consolidateAllBrains(workspaceId: string, opts: ConsolidateOpts = {}): Promise<{ ran: number; touched: number; results: ConsolidateResult[] }> {
  const sb = createAdminClient()
  const { data: brains } = await sb
    .from('brains')
    .select('id')
    .eq('workspace_id', workspaceId)
  const results: ConsolidateResult[] = []
  let touched = 0
  for (const r of brains || []) {
    try {
      const res = await consolidateBrain(r.id, opts)
      results.push(res)
      if (!res.skipped) touched++
    } catch (err: any) {
      console.error(`[brain.consolidate] ${r.id}: ${err.message}`)
    }
  }
  return { ran: (brains || []).length, touched, results }
}
