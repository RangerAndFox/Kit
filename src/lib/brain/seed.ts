// @ts-nocheck
/**
 * Build an initial brain for one project channel from existing project data
 * and recent notes.
 *
 * Phase 1: deterministic skeleton — no LLM. The Brain Writer (Phase 2) will
 * augment / patch this over time as messages flow in. The seed populates:
 *   - Operating context: client, producer, dates, budget, links
 *   - Conventions & specs: SOW summary (if present)
 *   - Watchlist: the project's target_delivery as a flagged item
 *   - People & roles: producer mention (when a slack id exists)
 *   - Glossary / canonical IDs: project code / id
 *   - Recent decisions: latest 5 notes attached to the project
 *   - Open decisions: empty (Phase 2 fills)
 *
 * Spec: KIT-BRAIN-SPEC.md §2.2, §3.0
 */

import { createAdminClient } from '@/lib/supabase/admin'
import {
  type Brain,
  type BrainBullet,
  type BrainProvenance,
  buildBrainId,
} from './format'
import { createBrain, getBrainByChannel, type LoadedBrain } from './store'

export interface SeedInput {
  workspaceId: string
  slackChannelId: string
  author?: string
}

export interface SeedResult {
  loaded: LoadedBrain
  created: boolean
}

interface ProjectRow {
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
  brief_summary: string | null
  sow_summary: string | null
  external_links: Record<string, unknown> | null
  project_manager_slack_id: string | null
  slack_channel_id: string | null
}

async function resolveProjectForChannel(channelId: string): Promise<ProjectRow | null> {
  const sb = createAdminClient()
  // Mirror the resolution pattern in bolt/src/notes/handler.ts: projects can
  // store the channel id either on `slack_channel_id` directly or in
  // `external_links.slack_id` / `external_links.slack_channel_id`.
  const { data } = await sb
    .from('projects')
    .select(
      'id, workspace_id, name, client, project_code, project_type, status, start_date, target_delivery, budget_total, brief_summary, sow_summary, external_links, project_manager_slack_id, slack_channel_id',
    )
    .or(
      `external_links->>slack_id.eq.${channelId},external_links->>slack_channel_id.eq.${channelId},slack_channel_id.eq.${channelId}`,
    )
    .maybeSingle()
  return (data as ProjectRow) ?? null
}

async function recentNotesForProject(projectId: string, limit = 5): Promise<Array<{ title: string | null; content: string; source_url: string | null; created_at: string | null }>> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('project_documents')
    .select('title, content, source_url, indexed_at')
    .eq('project_id', projectId)
    .eq('doc_type', 'note')
    .order('indexed_at', { ascending: false })
    .limit(limit)
  return (data || []).map((r: any) => ({
    title: r.title ?? null,
    content: r.content || '',
    source_url: r.source_url ?? null,
    created_at: r.indexed_at ?? null,
  }))
}

function bullet(text: string, prov?: BrainProvenance, checked: boolean | null = null): BrainBullet {
  return { text, provenance: prov, checked }
}

function noteSummary(content: string, max = 160): string {
  const first = content.split(/\n+/)[0].trim()
  return first.length > max ? first.slice(0, max - 1).trimEnd() + '…' : first
}

export function buildInitialBrain(project: ProjectRow, notes: Array<{ title: string | null; content: string; source_url: string | null; created_at: string | null }>): Brain {
  const code = project.project_code || '—'
  const name = project.name || '(untitled project)'
  const client = project.client || '—'

  const provHarvest: BrainProvenance = { src: project.project_code ? `harvest:proj/${project.project_code}` : 'harvest:project' }
  const provSow: BrainProvenance = { src: project.project_code ? `sow:${project.project_code}` : 'sow' }

  const sections: Brain['sections'] = []

  // Operating context
  const operating: BrainBullet[] = []
  operating.push(bullet(`Client: ${client}. Project: ${name}.`, provHarvest))
  if (project.status) operating.push(bullet(`Status: ${project.status}.`, provHarvest))
  if (project.start_date) operating.push(bullet(`Start date: ${project.start_date}.`, provHarvest))
  if (project.target_delivery) operating.push(bullet(`Target delivery: ${project.target_delivery}.`, provSow))
  if (project.budget_total != null) operating.push(bullet(`Budget total: $${project.budget_total}.`, provHarvest))
  if (project.brief_summary?.trim()) {
    operating.push(bullet(`Brief: ${noteSummary(project.brief_summary, 200)}`, provSow))
  }
  if (project.external_links && typeof project.external_links === 'object') {
    for (const [k, v] of Object.entries(project.external_links)) {
      if (typeof v === 'string' && v.startsWith('http')) {
        operating.push(bullet(`${k}: ${v}`, { src: `link:${k}` }))
      }
    }
  }
  sections.push({ heading: 'Operating context', bullets: operating })

  // Conventions & specs
  const conventions: BrainBullet[] = []
  if (project.sow_summary?.trim()) {
    conventions.push(bullet(noteSummary(project.sow_summary, 240), provSow))
  } else {
    conventions.push(bullet('No conventions captured yet. Add via @Kit note.', { src: 'system' }))
  }
  sections.push({ heading: 'Conventions & specs', bullets: conventions })

  // Open decisions (empty placeholder so the writer has a stable section anchor)
  sections.push({
    heading: 'Open decisions',
    bullets: [bullet('No open decisions tracked yet.', { src: 'system' })],
  })

  // Recent decisions (log) — from notes
  const decisions: BrainBullet[] = []
  for (const n of notes) {
    const stamp = (n.created_at || '').slice(0, 10)
    const txt = `${stamp ? stamp + ': ' : ''}${noteSummary(n.content, 200)}`
    decisions.push(bullet(txt, { src: n.source_url || `note:${(n.title || '').slice(0, 60)}` }))
  }
  if (decisions.length === 0) {
    decisions.push(bullet('No decisions logged yet.', { src: 'system' }))
  }
  sections.push({ heading: 'Recent decisions (log)', bullets: decisions })

  // Watchlist (deadlines & risks)
  const watchlist: BrainBullet[] = []
  if (project.target_delivery) {
    watchlist.push(bullet(`⚠️ ${project.target_delivery} — final delivery target.`, provSow))
  }
  if (watchlist.length === 0) {
    watchlist.push(bullet('No watchlist items yet.', { src: 'system' }))
  }
  sections.push({ heading: 'Watchlist (deadlines & risks)', bullets: watchlist })

  // People & roles
  const people: BrainBullet[] = []
  if (project.project_manager_slack_id) {
    people.push(bullet(`Producer: <@${project.project_manager_slack_id}> — final approver on client-facing sends.`, provHarvest))
  } else {
    people.push(bullet('No producer assigned yet.', { src: 'system' }))
  }
  sections.push({ heading: 'People & roles', bullets: people })

  // Glossary / canonical IDs
  const glossary: BrainBullet[] = []
  if (project.project_code) glossary.push(bullet(`Project code: ${project.project_code}.`, provHarvest))
  glossary.push(bullet(`Internal project id: ${project.id}.`, provHarvest))
  if (project.project_type) glossary.push(bullet(`Project type: ${project.project_type}.`, provHarvest))
  sections.push({ heading: 'Glossary / canonical IDs', bullets: glossary })

  const slug = (project.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  const brainId = buildBrainId({ scope: 'project', projectCode: project.project_code || '', slug })

  return {
    frontmatter: {
      brain_id: brainId,
      scope: 'project',
      project_code: project.project_code || undefined,
      project_id: project.id,
      slack_channel: project.slack_channel_id || undefined,
      revision: 1,
      updated: new Date().toISOString(),
    },
    title: `Brain — ${name} (${code})`,
    sections,
  }
}

/**
 * Seed (or fetch existing) brain for the channel. Idempotent — if a brain
 * already exists for (workspace, channel), it's returned as-is and
 * `created: false`. Otherwise an initial brain is built and persisted.
 */
export async function seedBrainForChannel(input: SeedInput): Promise<SeedResult> {
  const existing = await getBrainByChannel(input.workspaceId, input.slackChannelId)
  if (existing) return { loaded: existing, created: false }

  const project = await resolveProjectForChannel(input.slackChannelId)
  if (!project) {
    throw new Error(
      `seedBrainForChannel: no project linked to channel ${input.slackChannelId}. Link the channel to a project before seeding a brain.`,
    )
  }
  const notes = await recentNotesForProject(project.id)
  const brain = buildInitialBrain(project, notes)
  const loaded = await createBrain({
    id: brain.frontmatter.brain_id!,
    workspaceId: input.workspaceId,
    scope: 'project',
    projectCode: project.project_code,
    projectId: project.id,
    slackChannel: input.slackChannelId,
    autonomy: (process.env.KIT_BRAIN_AUTONOMY as any) || 'autonomous',
    brain,
    author: input.author,
  })
  return { loaded, created: true }
}
