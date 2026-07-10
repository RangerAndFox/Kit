// @ts-nocheck
/**
 * One-shot Harvest → projects + RAG backfill.
 *
 * Reconciles the Supabase `projects` table with Harvest, then embeds each
 * project as a project_documents row. Reconciliation matches on the project
 * NUMBER (not harvest_project_id, which is null on almost every row), so it
 * never inserts duplicates or clobbers modal-provisioned rows — the same safe
 * logic behind `/kit sync-projects`.
 *
 * Run with: npx tsx scripts/backfill-projects-from-harvest.ts
 *
 * Requires env: HARVEST_ACCESS_TOKEN, HARVEST_ACCOUNT_ID, SUPABASE_URL,
 *   SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, KIT_DEFAULT_WORKSPACE_ID.
 *
 * Idempotent — safe to re-run.
 */

import { embedAllProjects } from '../src/lib/studio-knowledge/project-summary'
import { syncProjectsFromHarvest } from '../src/lib/studio-knowledge/project-sync'

async function main() {
  const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
  if (!workspaceId) throw new Error('KIT_DEFAULT_WORKSPACE_ID required')

  console.log('Reconciling Harvest → Supabase projects...')
  const res = await syncProjectsFromHarvest({ dryRun: false })
  console.log(
    `  Inserted ${res.inserted}, linked ${res.linked}, already linked ${res.alreadyLinked}, ambiguous ${res.ambiguous.length}.`,
  )
  for (const a of res.ambiguous) console.log(`  ambiguous: ${a.harvest} — ${a.reason}`)

  console.log('Embedding all projects into RAG...')
  const stats = await embedAllProjects(workspaceId)
  console.log(`  Embedded: ${stats.embedded}, failed: ${stats.failed}.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
