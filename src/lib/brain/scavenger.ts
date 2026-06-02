// @ts-nocheck
/**
 * Brain Scavenger — Phase 5.
 *
 * For each brain, walks the Open decisions + Watchlist sections and
 * searches Kit's wider RAG (project_documents across OTHER projects +
 * the studio-level docs) for items semantically related to each open
 * question. Top novel candidates per brain are recorded as pending
 * brain_scavenger_candidates rows; the cron driver then DMs the channel
 * creator for approval.
 *
 * Cross-boundary context donation is structurally gated — even under
 * "fully autonomous" mode. This module never adds anything to a brain
 * on its own; it only queues candidates. Applying the patch happens in
 * approvals.ts after explicit human approval.
 *
 * Spec: KIT-BRAIN-SPEC.md §3.3
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { searchDocuments, type SearchResult } from '@/lib/rag/query'
import {
  type Brain,
  type BrainBullet,
  parseBrain,
} from './format'

export interface ScavengerCandidate {
  brainId: string
  workspaceId: string
  /** Source ref string for provenance — e.g. "doc:<uuid>" or document title. */
  sourceRef: string
  sourceDocId: string | null
  summary: string
  whyRelevant: string
  similarity: number
  /** Which brain bullet inspired this hunt — for the "this answers your X" copy. */
  triggerBullet: string
  /** Suggested section to add the candidate to if approved. */
  suggestedSection: string
}

interface BrainRow {
  id: string
  workspace_id: string
  project_id: string | null
  slack_channel: string | null
  markdown: string
}

const HUNT_SECTIONS = new Set([
  'Open decisions',
  'Watchlist (deadlines & risks)',
  'Watchlist',
])

const SUGGESTED_SECTION_FOR_TRIGGER = {
  'Open decisions': 'Open decisions',
  'Watchlist (deadlines & risks)': 'Watchlist (deadlines & risks)',
  'Watchlist': 'Watchlist (deadlines & risks)',
} as Record<string, string>

const MIN_SIMILARITY = 0.55           // semantic floor — anything below is noise
const MAX_PER_BRAIN = 5               // soft cap on candidates per run
const MAX_PER_BULLET = 2              // cap per individual brain bullet
const CANDIDATE_POOL = 12             // how many hits to ask the RPC for per bullet

// ─── Candidate finder ──────────────────────────────────────────────────────

export interface FindCandidatesOpts {
  brain: Brain
  brainRow: BrainRow
  /** Existing brain bullet texts to dedupe against — populated by caller. */
  existingBulletTexts: string[]
}

export async function findCandidatesForBrain(opts: FindCandidatesOpts): Promise<ScavengerCandidate[]> {
  const { brain, brainRow } = opts
  const ownProjectId = brainRow.project_id
  const out: ScavengerCandidate[] = []

  // Gather hunt-triggering bullets (skip system placeholders + strikethrough).
  const hunts: Array<{ section: string; bullet: BrainBullet }> = []
  for (const section of brain.sections) {
    if (!HUNT_SECTIONS.has(section.heading)) continue
    for (const b of section.bullets) {
      if (b.provenance?.src === 'system') continue
      if (/^~~/.test(b.text)) continue // already-superseded
      hunts.push({ section: section.heading, bullet: b })
    }
  }
  if (hunts.length === 0) return []

  // Dedup index: lower-cased bullet snippets the brain already knows.
  const knownSnippets = new Set<string>()
  for (const t of opts.existingBulletTexts) {
    const snippet = normalizeSnippet(t)
    if (snippet) knownSnippets.add(snippet)
  }

  for (const hunt of hunts) {
    if (out.length >= MAX_PER_BRAIN) break
    let kept = 0
    let hits: SearchResult[]
    try {
      hits = await searchDocuments(hunt.bullet.text, {
        workspaceId: brainRow.workspace_id,
        projectId: null,         // intentionally workspace-wide
        limit: CANDIDATE_POOL,
      })
    } catch (err: any) {
      console.error('[brain.scavenger] searchDocuments failed:', err.message || err)
      continue
    }
    for (const hit of hits) {
      if (kept >= MAX_PER_BULLET) break
      if (out.length >= MAX_PER_BRAIN) break
      if (hit.similarity < MIN_SIMILARITY) continue

      // Skip hits attached to this brain's own project. Cross-boundary
      // is the whole point.
      if (ownProjectId && (hit.metadata as any)?.project_id === ownProjectId) continue
      // Also skip if the hit doc IS one of our brain sections.
      if (hit.docType === 'brain_section' && (hit.metadata as any)?.brain_id === brainRow.id) continue

      // Dedup against bullets we already have.
      const hitSnippet = normalizeSnippet(hit.content)
      if (hitSnippet && knownSnippets.has(hitSnippet)) continue

      const summary = shortText(hit.content, 240)
      out.push({
        brainId: brainRow.id,
        workspaceId: brainRow.workspace_id,
        sourceRef: hit.sourceUrl || `doc:${hit.documentId}`,
        sourceDocId: hit.documentId,
        summary,
        whyRelevant: buildWhyRelevant(hunt.bullet.text, hit),
        similarity: hit.similarity,
        triggerBullet: hunt.bullet.text,
        suggestedSection: SUGGESTED_SECTION_FOR_TRIGGER[hunt.section] || 'Open decisions',
      })
      kept++
    }
  }
  return out
}

function normalizeSnippet(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120)
}

function shortText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1).trimEnd() + '…'
}

function buildWhyRelevant(triggerBullet: string, hit: SearchResult): string {
  const titleClue = hit.title ? `From "${hit.title}"` : 'From a related document'
  const trigger = shortText(triggerBullet, 80)
  return `${titleClue} (similarity ${hit.similarity.toFixed(2)}). Related to: ${trigger}`
}

// ─── Queue persistence ─────────────────────────────────────────────────────

export async function queueCandidates(candidates: ScavengerCandidate[]): Promise<{ inserted: number; skipped_duplicate: number }> {
  if (candidates.length === 0) return { inserted: 0, skipped_duplicate: 0 }
  const sb = createAdminClient()
  let inserted = 0
  let skippedDuplicate = 0
  for (const c of candidates) {
    // Skip if a pending row already exists for this (brain, source_doc_id).
    if (c.sourceDocId) {
      const { data: existing } = await sb
        .from('brain_scavenger_candidates')
        .select('id')
        .eq('brain_id', c.brainId)
        .eq('source_doc_id', c.sourceDocId)
        .in('status', ['pending', 'approved'])
        .limit(1)
      if (existing && existing.length > 0) {
        skippedDuplicate++
        continue
      }
    }
    const { error } = await sb.from('brain_scavenger_candidates').insert({
      brain_id: c.brainId,
      workspace_id: c.workspaceId,
      source_ref: c.sourceRef,
      source_doc_id: c.sourceDocId,
      summary: c.summary,
      why_relevant: c.whyRelevant,
      similarity: c.similarity,
      status: 'pending',
    })
    if (error) {
      console.error('[brain.scavenger] insert failed:', error.message)
      continue
    }
    inserted++
  }
  return { inserted, skipped_duplicate: skippedDuplicate }
}

// ─── Per-workspace driver ──────────────────────────────────────────────────

export interface RunOpts {
  workspaceId: string
}

export interface RunResult {
  brainsScanned: number
  candidatesFound: number
  candidatesQueued: number
}

/**
 * Walk every brain in the workspace, find + queue candidates.
 * Channel-creator DM dispatch is the caller's job (lives in
 * bolt/src/brain/approvals.ts so it has the Bolt App handle).
 */
export async function runScavengerForWorkspace(opts: RunOpts): Promise<RunResult> {
  const sb = createAdminClient()
  const { data: rows } = await sb
    .from('brains')
    .select('id, workspace_id, project_id, slack_channel, markdown')
    .eq('workspace_id', opts.workspaceId)
  let brainsScanned = 0
  let candidatesFound = 0
  let candidatesQueued = 0
  for (const row of rows || []) {
    if (!row.slack_channel || !row.markdown) continue
    brainsScanned++
    const brain = parseBrain(row.markdown)
    const existingBulletTexts: string[] = []
    for (const s of brain.sections) {
      for (const b of s.bullets) existingBulletTexts.push(b.text)
    }
    const candidates = await findCandidatesForBrain({ brain, brainRow: row as BrainRow, existingBulletTexts })
    if (candidates.length === 0) continue
    candidatesFound += candidates.length
    const { inserted } = await queueCandidates(candidates)
    candidatesQueued += inserted
  }
  return { brainsScanned, candidatesFound, candidatesQueued }
}

// ─── Lookups for approvals.ts ──────────────────────────────────────────────

export interface PendingCandidateRow {
  id: number
  brain_id: string
  workspace_id: string
  source_ref: string | null
  source_doc_id: string | null
  summary: string | null
  why_relevant: string | null
  similarity: number | null
  applied_section: string | null
}

export async function getPendingForBrain(brainId: string): Promise<PendingCandidateRow[]> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('brain_scavenger_candidates')
    .select('id, brain_id, workspace_id, source_ref, source_doc_id, summary, why_relevant, similarity, applied_section')
    .eq('brain_id', brainId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
  return (data as PendingCandidateRow[]) || []
}

export async function getCandidate(id: number): Promise<PendingCandidateRow | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('brain_scavenger_candidates')
    .select('id, brain_id, workspace_id, source_ref, source_doc_id, summary, why_relevant, similarity, applied_section')
    .eq('id', id)
    .maybeSingle()
  return (data as PendingCandidateRow) || null
}

export async function markCandidateDecided(opts: {
  id: number
  status: 'approved' | 'rejected' | 'expired'
  approver?: string | null
  appliedSection?: string | null
}): Promise<void> {
  const sb = createAdminClient()
  const { error } = await sb
    .from('brain_scavenger_candidates')
    .update({
      status: opts.status,
      approver: opts.approver ?? null,
      applied_section: opts.appliedSection ?? null,
      decided_at: new Date().toISOString(),
    })
    .eq('id', opts.id)
  if (error) throw new Error(`markCandidateDecided: ${error.message}`)
}
