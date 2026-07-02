// @ts-nocheck
/**
 * Brain store — load/save a brain (markdown body + brains row + audit trail).
 *
 * The markdown body is the source of truth. The brains row is metadata +
 * a mirror of the body for fast reads. Every write bumps `revision`, writes
 * an audit row to brain_revisions, and re-embeds the touched sections into
 * project_documents so the existing match_documents RPC serves retrieval.
 *
 * Spec: KIT-BRAIN-SPEC.md §2.3, §5
 */

import { createAdminClient } from '@/lib/supabase/admin'
import {
  type Brain,
  type BrainPatch,
  parseBrain,
  serializeBrain,
  applyPatch,
} from './format'
import { upsertDocument } from '@/lib/rag/ingest'

export interface BrainRow {
  id: string
  workspace_id: string
  scope: 'studio' | 'project'
  project_code: string | null
  project_id: string | null
  slack_channel: string | null
  revision: number
  markdown: string
  canvas_id: string | null
  canvas_url: string | null
  autonomy: 'autonomous' | 'gated' | 'ask_first'
  visibility: 'team' | 'producers_only'
  created_at?: string
  updated_at?: string
}

export interface LoadedBrain {
  row: BrainRow
  brain: Brain
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function getBrainById(id: string): Promise<LoadedBrain | null> {
  const sb = createAdminClient()
  const { data, error } = await sb.from('brains').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`getBrainById: ${error.message}`)
  if (!data) return null
  return { row: data as BrainRow, brain: parseBrain(data.markdown || '') }
}

export async function getBrainByChannel(workspaceId: string, slackChannel: string): Promise<LoadedBrain | null> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('brains')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('slack_channel', slackChannel)
    .maybeSingle()
  if (error) throw new Error(`getBrainByChannel: ${error.message}`)
  if (!data) return null
  return { row: data as BrainRow, brain: parseBrain(data.markdown || '') }
}

// ─── Writes ────────────────────────────────────────────────────────────────

export interface CreateBrainInput {
  id: string
  workspaceId: string
  scope: 'studio' | 'project'
  projectCode?: string | null
  projectId?: string | null
  slackChannel?: string | null
  autonomy?: 'autonomous' | 'gated' | 'ask_first'
  visibility?: 'team' | 'producers_only'
  brain: Brain
  author?: string
}

export async function createBrain(input: CreateBrainInput): Promise<LoadedBrain> {
  const sb = createAdminClient()
  // Stamp frontmatter so the markdown body matches the row.
  const brain: Brain = {
    ...input.brain,
    frontmatter: {
      ...input.brain.frontmatter,
      brain_id: input.id,
      scope: input.scope,
      project_code: input.projectCode || input.brain.frontmatter.project_code,
      project_id: input.projectId || input.brain.frontmatter.project_id,
      slack_channel: input.slackChannel || input.brain.frontmatter.slack_channel,
      revision: 1,
      updated: new Date().toISOString(),
    },
  }
  const markdown = serializeBrain(brain)
  const { data, error } = await sb
    .from('brains')
    .insert({
      id: input.id,
      workspace_id: input.workspaceId,
      scope: input.scope,
      project_code: input.projectCode ?? null,
      project_id: input.projectId ?? null,
      slack_channel: input.slackChannel ?? null,
      revision: 1,
      markdown,
      autonomy: input.autonomy ?? 'autonomous',
      // Secure-by-default. Producers can promote a brain to 'team'
      // (channel-canvas) via /kit brain visibility team — see commands.ts.
      visibility: input.visibility ?? 'producers_only',
    })
    .select('*')
    .single()
  if (error) throw new Error(`createBrain: ${error.message}`)

  await sb.from('brain_revisions').insert({
    brain_id: input.id,
    revision: 1,
    operation: 'seed',
    diff: 'initial seed',
    author: input.author ?? 'system',
  })

  await embedBrainSections(input.workspaceId, input.id, input.projectId ?? null, brain, /* sections */ null)

  return { row: data as BrainRow, brain }
}

/**
 * Apply a set of patches to an existing brain. Atomic at the row level
 * (single UPDATE bumps revision); audit rows + embeddings are best-effort
 * after the write.
 *
 * Optimistic concurrency: the UPDATE is predicated on the revision we read.
 * Without it, the message-driven writer and the nightly consolidator racing
 * the same brain meant read-modify-write lost the first writer's patches
 * wholesale. On conflict we re-read and retry (bounded).
 */
export async function applyPatches(opts: {
  brainId: string
  patches: BrainPatch[]
  author?: string
}): Promise<LoadedBrain> {
  const MAX_ATTEMPTS = 3
  let lastConflict: string | null = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const loaded = await getBrainById(opts.brainId)
    if (!loaded) throw new Error(`applyPatches: brain ${opts.brainId} not found`)
    const { row, brain } = loaded
    const touchedSections = new Set<string>()
    const diffs: string[] = []
    for (const p of opts.patches) {
      const d = applyPatch(brain, p)
      if (d) {
        diffs.push(d)
        touchedSections.add(p.section)
      }
    }
    const nextRevision = (row.revision || 0) + 1
    brain.frontmatter.revision = nextRevision
    brain.frontmatter.updated = new Date().toISOString()
    const markdown = serializeBrain(brain)

    const sb = createAdminClient()
    const { data, error } = await sb
      .from('brains')
      .update({ markdown, revision: nextRevision, updated_at: new Date().toISOString() })
      .eq('id', opts.brainId)
      .eq('revision', row.revision ?? 0)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(`applyPatches: ${error.message}`)
    if (!data) {
      // Someone else bumped the revision between our read and write — retry
      // against the fresh state so their patches survive alongside ours.
      lastConflict = `revision ${row.revision} was stale`
      continue
    }

    // Audit one row per patch.
    if (opts.patches.length > 0) {
      await sb.from('brain_revisions').insert(
        opts.patches.map((p, i) => ({
          brain_id: opts.brainId,
          revision: nextRevision,
          section: p.section,
          operation: p.operation,
          diff: diffs[i] || null,
          provenance: p.provenance ?? null,
          author: opts.author ?? 'system',
        })),
      )
    }

    await embedBrainSections(row.workspace_id, opts.brainId, row.project_id, brain, touchedSections)

    return { row: data as BrainRow, brain }
  }

  throw new Error(
    `applyPatches: gave up after ${MAX_ATTEMPTS} optimistic-concurrency retries (${lastConflict})`,
  )
}

export async function setCanvasHandle(brainId: string, canvasId: string, canvasUrl: string | null): Promise<void> {
  const sb = createAdminClient()
  const { error } = await sb
    .from('brains')
    .update({ canvas_id: canvasId, canvas_url: canvasUrl, updated_at: new Date().toISOString() })
    .eq('id', brainId)
  if (error) throw new Error(`setCanvasHandle: ${error.message}`)
}

// ─── RAG indexing ──────────────────────────────────────────────────────────

/**
 * Re-embed brain sections into project_documents so match_documents can
 * retrieve them. When `touchedSections` is non-null, only those are
 * re-embedded; null means embed every section (used on seed).
 *
 * Each section becomes its own row with a stable title:
 *   "Brain · <brain_id> · <section>"
 * upsertDocument matches on (workspace_id, doc_type, title) so re-running
 * is idempotent.
 */
export async function embedBrainSections(
  workspaceId: string,
  brainId: string,
  projectId: string | null,
  brain: Brain,
  touchedSections: Set<string> | null,
): Promise<void> {
  // OpenAI key is required for embeddings; skip silently if it's not
  // configured. Phase 1 ships before the operator has activated Studio
  // Knowledge — better to seed the brain than fail the whole write.
  if (!process.env.OPENAI_API_KEY) return

  for (const section of brain.sections) {
    if (touchedSections && !touchedSections.has(section.heading)) continue
    const content = renderSectionForEmbedding(brain, section.heading)
    if (!content.trim()) continue
    try {
      await upsertDocument({
        workspaceId,
        projectId: projectId ?? null,
        docType: 'brain_section',
        title: `Brain · ${brainId} · ${section.heading}`,
        content,
        visibilityTier: 'team',
        metadata: { brain_id: brainId, section: section.heading },
      })
    } catch (err: any) {
      console.error(`[brain.store] embed section "${section.heading}" failed:`, err.message)
    }
  }
}

function renderSectionForEmbedding(brain: Brain, heading: string): string {
  const s = brain.sections.find((x) => x.heading === heading)
  if (!s) return ''
  const lines: string[] = []
  const projectCode = brain.frontmatter.project_code
  const channel = brain.frontmatter.slack_channel
  // A retrieval-friendly preface helps semantic search lock on.
  lines.push(`Brain section: ${heading}`)
  if (projectCode) lines.push(`Project: ${projectCode}`)
  if (channel) lines.push(`Channel: ${channel}`)
  lines.push('')
  if (s.preamble) lines.push(s.preamble)
  for (const b of s.bullets) {
    lines.push(`- ${b.text}`)
  }
  return lines.join('\n')
}
