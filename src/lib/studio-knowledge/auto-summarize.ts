/**
 * Auto-summarization — generates a Claude-written 1-pager per project from
 * structural data + notes + transcripts + recent actions, then re-embeds
 * the result as the project's project_summary doc (replacing the static
 * version P1 produced).
 *
 * Run by the nightly Inngest cron or on-demand via studio_knowledge.regenerate_summary.
 */

import Anthropic from '@anthropic-ai/sdk'
import { createAdminClient } from '../supabase/admin'
import { upsertDocument } from '../rag/ingest'
import { embedTeamProjectSummary, type ProjectSummaryInput } from './project-summary'
import { readBoundedPages } from './bounded-pages'

const SUMMARY_MODEL = 'claude-haiku-4-5-20251001'

const SYSTEM_PROMPT = `You write concise narrative summaries of video studio projects for a knowledge base.

Given a project's structural data + recent notes + transcript excerpts + open action items, produce a markdown 1-pager (~250 words) that captures:

1. What the project is (one sentence — client + format + intent).
2. Status + key dates + budget.
3. Current state of play — pulled from the most recent notes/transcripts (be specific; quote one or two lines if useful).
4. Open questions or risks if any are surfaced in the materials.
5. Cast of characters — producer + key client contacts (only those mentioned in the source material).

Rules:
- Do not invent facts. If the materials don't mention a field, leave it out.
- Do not editorialize ("this is going great", "should be smooth sailing"). Stick to what the materials say.
- Use markdown headings and bullets where it aids scanning.
- Output ONLY the markdown body. No preamble, no closing line, no commentary.`

interface ProjectContext {
  project: ProjectSummaryInput | null
  notes: Array<{ title: string; content: string; created_at: string | null }>
  transcripts: Array<{ title: string; content: string; created_at: string | null }>
  actions: Array<{ title: string; body: string; status: string | null }>
}

async function gatherProjectContext(workspaceId: string, projectId: string): Promise<ProjectContext> {
  const sb = createAdminClient()
  const [projectResult, docsResult, actionsResult] = await Promise.all([
    sb.from('projects').select('*').eq('workspace_id', workspaceId).eq('id', projectId).maybeSingle(),
    sb
      .from('project_documents')
      .select('title, content, doc_type, created_at')
      .eq('workspace_id', workspaceId)
      .eq('project_id', projectId)
      // The narrative is founder-only; team retrieval gets a separate,
      // deterministic structured derivative with no freeform source text.
      .in('doc_type', ['note', 'call_transcript_safe'])
      .order('created_at', { ascending: false })
      .limit(40),
    sb
      .from('kit_actions')
      .select('title, body, status')
      .eq('workspace_id', workspaceId)
      .eq('project_id', projectId)
      .in('status', ['pending', 'approved'])
      .limit(10),
  ])
  if (projectResult.error || docsResult.error || actionsResult.error) throw new Error('Project summary source lookup failed')
  const notes = (docsResult.data || []).filter(d => d.doc_type === 'note').slice(0, 20)
  const transcripts = (docsResult.data || []).filter(d => d.doc_type === 'call_transcript_safe').slice(0, 10)
  return { project: projectResult.data as ProjectSummaryInput | null, notes, transcripts, actions: actionsResult.data || [] }
}

function buildPromptText(ctx: ProjectContext): string {
  const p = ctx.project
  if (!p) throw new Error('Project summary requires a verified project')
  const lines: string[] = []
  lines.push('# Project metadata')
  lines.push(`Name: ${p.name || '(unnamed)'}`)
  if (p.client) lines.push(`Client: ${p.client}`)
  if (p.project_code) lines.push(`Code: ${p.project_code}`)
  if (p.project_type) lines.push(`Type: ${p.project_type}`)
  if (p.status) lines.push(`Status: ${p.status}`)
  if (p.start_date) lines.push(`Started: ${p.start_date}`)
  if (p.target_delivery) lines.push(`Target delivery: ${p.target_delivery}`)
  if (p.budget_total != null) {
    const spent = p.budget_spent != null ? ` (spent: $${p.budget_spent})` : ''
    lines.push(`Budget: $${p.budget_total}${spent}`)
  }
  if (p.project_manager_slack_id) lines.push(`Producer (Slack): ${p.project_manager_slack_id}`)
  if (p.brief_summary) lines.push('', '## Brief', p.brief_summary)
  if (p.sow_summary) lines.push('', '## SOW', p.sow_summary)

  if (ctx.notes.length > 0) {
    lines.push('', '# Recent notes (newest first)')
    for (const n of ctx.notes) {
      lines.push(`- [${n.created_at?.slice(0, 10)}] ${n.content}`)
    }
  }

  if (ctx.transcripts.length > 0) {
    lines.push('', '# Transcript excerpts (most recent meetings)')
    for (const t of ctx.transcripts) {
      const snippet = (t.content || '').slice(0, 800)
      lines.push(`- [${t.created_at?.slice(0, 10)} · ${t.title}]`)
      lines.push(snippet)
    }
  }

  if (ctx.actions.length > 0) {
    lines.push('', '# Open action items')
    for (const a of ctx.actions) {
      lines.push(`- (${a.status}) ${a.title}${a.body ? ` — ${a.body}` : ''}`)
    }
  }

  return lines.join('\n')
}

export async function regenerateProjectSummary(workspaceId: string, projectId: string): Promise<{ documentId: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const ctx = await gatherProjectContext(workspaceId, projectId)
  if (!ctx.project) throw new Error(`regenerateProjectSummary: project ${projectId} not found`)

  // If there are no notes / transcripts / actions, fall back to the static
  // summary path (P1 composeProjectSummaryText) — Claude has nothing to add.
  if (ctx.notes.length === 0 && ctx.transcripts.length === 0 && ctx.actions.length === 0) {
    const { embedProjectSummary } = await import('./project-summary')
    return embedProjectSummary(ctx.project)
  }

  const client = new Anthropic({ apiKey })
  const userPrompt = buildPromptText(ctx)
  const res = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })
  const text = (res.content || [])
    .flatMap(c => c.type === 'text' ? [c.text] : [])
    .join('\n')
    .trim()
  if (!text) throw new Error('Claude returned empty summary')

  // Same title shape as project-summary.ts so upsertDocument replaces the
  // static version rather than creating a duplicate.
  const code = ctx.project.project_code || '—'
  const clientName = ctx.project.client || '—'
  const name = ctx.project.name || '(untitled project)'
  const title = `Project ${code} · ${clientName} · ${name}`

  const result = await upsertDocument({
    workspaceId,
    projectId,
    docType: 'project_summary',
    title,
    content: text,
    visibilityTier: 'founder',
    metadata: {
      client: ctx.project.client,
      project_code: ctx.project.project_code,
      status: ctx.project.status,
      budget_total: ctx.project.budget_total,
      generated_at: new Date().toISOString(),
      generator: 'claude-haiku-auto-summary',
      note_count: ctx.notes.length,
      transcript_count: ctx.transcripts.length,
      action_count: ctx.actions.length,
    },
  })
  await embedTeamProjectSummary(ctx.project)
  return result
}

export async function regenerateAllProjectSummaries(workspaceId: string, opts: { limit?: number } = {}): Promise<{ updated: number; failed: number; skipped: number }> {
  const sb = createAdminClient()
  const { data: projects, error } = await sb
    .from('projects')
    .select('id, status, updated_at')
    .eq('workspace_id', workspaceId)
    .in('status', ['active', 'archived'])
    .order('updated_at', { ascending: false })
    .limit(Math.max(1, Math.min(200, opts.limit ?? 200)))
  if (error) throw new Error(`regenerateAllProjectSummaries: ${error.message}`)

  const projectIds = (projects || []).map(p => p.id)
  if (!projectIds.length) return { updated: 0, failed: 0, skipped: 0 }
  // Scope both metadata scans to this bounded workspace/project batch. Page
  // explicitly; never mistake PostgREST's default row cap for a complete scan.
  const docRows = await readBoundedPages((from, to) => sb
    .from('project_documents')
    .select('project_id, doc_type, created_at, indexed_at')
    .eq('workspace_id', workspaceId)
    .in('project_id', projectIds)
    .in('doc_type', ['project_summary', 'project_summary_safe', 'note', 'call_transcript_safe'])
    .order('id').range(from, to))
  const summaryAt = new Map<string, number>()
  const safeSummaryAt = new Map<string, number>()
  const newestSourceAt = new Map<string, number>()
  for (const d of docRows || []) {
    if (!d.project_id) continue
    const ts = Date.parse(d.indexed_at || d.created_at || '') || 0
    if (d.doc_type === 'project_summary') {
      summaryAt.set(d.project_id, Math.max(summaryAt.get(d.project_id) || 0, ts))
    } else if (d.doc_type === 'project_summary_safe') {
      safeSummaryAt.set(d.project_id, Math.max(safeSummaryAt.get(d.project_id) || 0, ts))
    } else {
      newestSourceAt.set(d.project_id, Math.max(newestSourceAt.get(d.project_id) || 0, ts))
    }
  }

  // Open action items feed the summary too — without this, a project whose
  // only change is a new kit_action was skipped until something else moved.
  const actionRows = await readBoundedPages((from, to) => sb
    .from('kit_actions')
    .select('project_id, created_at')
    .eq('workspace_id', workspaceId)
    .in('project_id', projectIds)
    .in('status', ['suggested', 'pending', 'approved'])
    .order('id').range(from, to))
  for (const a of actionRows || []) {
    if (!a.project_id) continue
    const ts = Date.parse(a.created_at || '') || 0
    newestSourceAt.set(a.project_id, Math.max(newestSourceAt.get(a.project_id) || 0, ts))
  }

  let updated = 0
  let failed = 0
  let skipped = 0
  for (const p of projects || []) {
    const existing = Math.min(summaryAt.get(p.id) || 0, safeSummaryAt.get(p.id) || 0)
    const newestInput = Math.max(
      newestSourceAt.get(p.id) || 0,
      Date.parse(p.updated_at || '') || 0,
    )
    if (existing > 0 && newestInput <= existing) {
      skipped++
      continue
    }
    try {
      await regenerateProjectSummary(workspaceId, p.id)
      updated++
    } catch (err) {
      console.error(`[auto-summarize] failed for ${p.id}: ${err instanceof Error ? err.message : 'unknown error'}`)
      failed++
    }
  }
  return { updated, failed, skipped }
}
