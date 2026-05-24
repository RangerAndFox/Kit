// @ts-nocheck
/**
 * Compose a single-doc summary of a project that we embed into RAG so the
 * studio_knowledge agent can semantically retrieve it.
 *
 * The text combines structured fields + freeform brief into a single block
 * the embedding model can score against natural questions like
 * "what was our biggest Microsoft project last year".
 */

export interface ProjectSummaryInput {
  id: string
  workspace_id: string
  name: string | null
  client: string | null
  project_code: string | null
  project_type: string | null
  status: string | null
  start_date: string | null
  target_delivery: string | null
  budget_total: number | null
  budget_spent: number | null
  brief_summary: string | null
  sow_summary: string | null
  external_links: Record<string, unknown> | null
  project_manager_slack_id: string | null
  harvest_project_id: number | null
}

/**
 * Produce the canonical "project summary" text. Stable formatting so the
 * upsert path matches on (workspace_id, doc_type='project_summary', title).
 */
export function composeProjectSummaryText(p: ProjectSummaryInput): { title: string; content: string } {
  const code = p.project_code || '—'
  const client = p.client || '—'
  const name = p.name || '(untitled project)'
  const title = `Project ${code} · ${client} · ${name}`

  const lines: string[] = []
  lines.push(`# ${title}`)
  if (p.status) lines.push(`Status: ${p.status}`)
  if (p.project_type) lines.push(`Type: ${p.project_type}`)
  if (p.start_date) lines.push(`Started: ${p.start_date}`)
  if (p.target_delivery) lines.push(`Target delivery: ${p.target_delivery}`)
  if (p.budget_total != null) {
    const spent = p.budget_spent != null ? ` (spent so far: $${p.budget_spent})` : ''
    lines.push(`Budget: $${p.budget_total}${spent}`)
  }
  if (p.project_manager_slack_id) lines.push(`Producer (Slack user): ${p.project_manager_slack_id}`)
  if (p.harvest_project_id) lines.push(`Harvest project id: ${p.harvest_project_id}`)
  if (p.external_links && Object.keys(p.external_links).length > 0) {
    const links: string[] = []
    for (const [k, v] of Object.entries(p.external_links)) {
      if (typeof v === 'string' && v.startsWith('http')) links.push(`${k}: ${v}`)
    }
    if (links.length > 0) lines.push('', 'Links:', ...links.map((l) => `- ${l}`))
  }
  if (p.brief_summary?.trim()) {
    lines.push('', '## Brief', p.brief_summary.trim())
  }
  if (p.sow_summary?.trim()) {
    lines.push('', '## SOW', p.sow_summary.trim())
  }
  const content = lines.join('\n')
  return { title, content }
}

/**
 * Upsert a single project's summary doc into project_documents.
 */
import { upsertDocument } from '../rag/ingest'
export async function embedProjectSummary(p: ProjectSummaryInput): Promise<{ documentId: string }> {
  const { title, content } = composeProjectSummaryText(p)
  return upsertDocument({
    workspaceId: p.workspace_id,
    projectId: p.id,
    docType: 'project_summary',
    title,
    content,
    visibilityTier: 'team',
    metadata: {
      client: p.client,
      project_code: p.project_code,
      status: p.status,
      budget_total: p.budget_total,
      harvest_project_id: p.harvest_project_id,
      project_manager_slack_id: p.project_manager_slack_id,
    },
  })
}

/**
 * Re-embed all active+archived projects in a workspace. Idempotent via
 * upsertDocument. Returns count.
 */
import { createAdminClient } from '../supabase/admin'
export async function embedAllProjects(workspaceId: string): Promise<{ embedded: number; failed: number }> {
  const sb = createAdminClient()
  const { data: projects, error } = await sb
    .from('projects')
    .select('id, workspace_id, name, client, project_code, project_type, status, start_date, target_delivery, budget_total, budget_spent, brief_summary, sow_summary, external_links, project_manager_slack_id, harvest_project_id')
    .eq('workspace_id', workspaceId)
  if (error) throw new Error(`embedAllProjects: ${error.message}`)
  let embedded = 0
  let failed = 0
  for (const p of projects || []) {
    try {
      await embedProjectSummary(p as any)
      embedded++
    } catch (err: any) {
      console.error(`[studio-knowledge] embed failed for project ${p.id}: ${err.message}`)
      failed++
    }
  }
  return { embedded, failed }
}
