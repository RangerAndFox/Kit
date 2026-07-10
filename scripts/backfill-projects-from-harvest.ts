// @ts-nocheck
/**
 * One-shot Harvest → projects + RAG backfill.
 *
 * Pulls every project from Harvest (active + archived), upserts into the
 * Supabase `projects` table on `harvest_project_id` collision, then embeds
 * each project as a project_documents row.
 *
 * Run with: npx tsx scripts/backfill-projects-from-harvest.ts
 *
 * Requires env: HARVEST_ACCESS_TOKEN, HARVEST_ACCOUNT_ID, SUPABASE_URL,
 *   SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, KIT_DEFAULT_WORKSPACE_ID.
 *
 * Idempotent — safe to re-run. New projects get inserted; existing rows
 * keyed on harvest_project_id get updated. Embeddings are upserted by
 * (workspace_id, doc_type='project_summary', title) match.
 */

import { createAdminClient } from '../src/lib/supabase/admin'
import { embedAllProjects } from '../src/lib/studio-knowledge/project-summary'
import { harvestRequest } from './harvest-fetch'

interface HarvestProject {
  id: number
  name: string
  code?: string
  is_active: boolean
  starts_on?: string
  ends_on?: string
  budget?: number
  notes?: string
  client?: { id: number; name: string }
}


async function listAllHarvestProjects(): Promise<HarvestProject[]> {
  const out: HarvestProject[] = []
  let page = 1
  while (true) {
    const data = await harvestRequest(`/projects?per_page=100&page=${page}`)
    out.push(...(data.projects || []))
    if (!data.next_page) break
    page = data.next_page
  }
  return out
}

async function main() {
  const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
  if (!workspaceId) throw new Error('KIT_DEFAULT_WORKSPACE_ID required')

  console.log('Pulling Harvest projects...')
  const projects = await listAllHarvestProjects()
  console.log(`  Got ${projects.length} Harvest projects.`)

  const sb = createAdminClient()
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const hp of projects) {
    const code = hp.code || null
    const name = hp.name || '(unnamed)'
    const client = hp.client?.name || null

    // Try to find existing by harvest_project_id
    const { data: existing } = await sb
      .from('projects')
      .select('id')
      .eq('harvest_project_id', hp.id)
      .maybeSingle()

    const row = {
      workspace_id: workspaceId,
      name,
      client,
      project_code: code,
      status: hp.is_active ? 'active' : 'archived',
      start_date: hp.starts_on || null,
      target_delivery: hp.ends_on || null,
      budget_total: hp.budget ?? null,
      brief_summary: hp.notes || null,
      harvest_project_id: hp.id,
      updated_at: new Date().toISOString(),
    }

    if (existing?.id) {
      const { error } = await sb.from('projects').update(row).eq('id', existing.id)
      if (error) {
        console.warn(`  update failed for harvest_project_id=${hp.id}: ${error.message}`)
        skipped++
      } else updated++
    } else {
      const { error } = await sb.from('projects').insert(row)
      if (error) {
        console.warn(`  insert failed for harvest_project_id=${hp.id}: ${error.message}`)
        skipped++
      } else inserted++
    }
  }

  console.log(`Projects: ${inserted} inserted, ${updated} updated, ${skipped} skipped.`)

  console.log('Embedding all projects into RAG...')
  const stats = await embedAllProjects(workspaceId)
  console.log(`  Embedded: ${stats.embedded}, failed: ${stats.failed}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
