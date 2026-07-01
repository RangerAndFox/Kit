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
  project: any
  notes: Array<{ title: string; content: string; created_at: string | null }>
  transcripts: Array<{ title: string; content: string; created_at: string | null }>
  actions: Array<{ title: string; body: string; status: string | null }>
}

async function gatherProjectContext(workspaceId: string, projectId: string): Promise<ProjectContext> {
  const sb = createAdminClient()
  const [{ data: project }, { data: docs }, { data: actions }] = await Promise.all([
    sb.from('projects').select('*').eq('id', projectId).maybeSingle(),
    sb
      .from('project_documents')
      .select('title, content, doc_type, created_at')
      .eq('workspace_id', workspaceId)
      .eq('project_id', projectId)
      .in('doc_type', ['note', 'call_transcript'])
      .order('created_at', { ascending: false })
      .limit(40),
    sb
      .from('kit_actions')
      .select('title, body, status')
      .eq('project_id', projectId)
      .in('status', ['pending', 'approved'])
      .limit(10),
  ])
  const notes = (docs || []).filter((d: any) => d.doc_type === 'note').slice(0, 20)
  const transcripts = (docs || []).filter((d: any) => d.doc_type === 'call_transcript').slice(0, 10)
  return { project, notes, transcripts, actions: actions || [] }
}

function buildPromptText(ctx: ProjectContext): string {
  const p = ctx.project || {}
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
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
    .trim()
  if (!text) throw new Error('Claude returned empty summary')

  // Same title shape as project-summary.ts so upsertDocument replaces the
  // static version rather than creating a duplicate.
  const code = ctx.project.project_code || '—'
  const clientName = ctx.project.client || '—'
  const name = ctx.project.name || '(untitled project)'
  const title = `Project ${code} · ${clientName} · ${name}`

  return upsertDocument({
    workspaceId,
    projectId,
    docType: 'project_summary',
    title,
    content: text,
    visibilityTier: 'team',
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
}

export async function regenerateAllProjectSummaries(workspaceId: string, opts: { limit?: number } = {}): Promise<{ updated: number; failed: number; skipped: number }> {
  const sb = createAdminClient()
  const { data: projects, error } = await sb
    .from('projects')
    .select('id, status, updated_at')
    .eq('workspace_id', workspaceId)
    .in('status', ['active', 'archived'])
    .order('updated_at', { ascending: false })
    .limit(opts.limit ?? 200)
  if (error) throw new Error(`regenerateAllProjectSummaries: ${error.message}`)

  // Skip-unchanged: one query over the (small) document corpus gives us, per
  // project, when its summary was last written and when its newest source
  // material (note/transcript) landed. Only projects with newer material (or
  // a newer projects-row update, or no summary at all) pay the nightly
  // Haiku + embedding cost — this used to re-run for ALL ~200 projects
  // regardless of change.
  const { data: docRows } = await sb
    .from('project_documents')
    .select('project_id, doc_type, created_at, indexed_at')
    .eq('workspace_id', workspaceId)
    .in('doc_type', ['project_summary', 'note', 'call_transcript'])
  const summaryAt = new Map<string, number>()
  const newestSourceAt = new Map<string, number>()
  for (const d of docRows || []) {
    if (!d.project_id) continue
    const ts = Date.parse(d.indexed_at || d.created_at || '') || 0
    if (d.doc_type === 'project_summary') {
      summaryAt.set(d.project_id, Math.max(summaryAt.get(d.project_id) || 0, ts))
    } else {
      newestSourceAt.set(d.project_id, Math.max(newestSourceAt.get(d.project_id) || 0, ts))
    }
  }

  let updated = 0
  let failed = 0
  let skipped = 0
  for (const p of projects || []) {
    const existing = summaryAt.get(p.id) || 0
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
    } catch (err: any) {
      console.error(`[auto-summarize] failed for ${p.id}: ${err.message}`)
      failed++
    }
  }
  return { updated, failed, skipped }
}
