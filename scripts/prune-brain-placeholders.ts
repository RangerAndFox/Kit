// @ts-nocheck
/**
 * One-shot cleanup: prune the "No X yet" system placeholder bullets from
 * every brain that already has real content in those sections. Phase-1
 * brains were seeded with placeholders to give Haiku a stable patch
 * anchor; once real content arrives the placeholder is just noise.
 *
 * Idempotent — re-running on already-clean brains is a no-op.
 *
 * Run: npx tsx scripts/prune-brain-placeholders.ts
 */

import { createAdminClient } from '../src/lib/supabase/admin'
import { parseBrain, serializeBrain, pruneSystemPlaceholders } from '../src/lib/brain/format'

async function main() {
  const sb = createAdminClient()
  const { data: rows, error } = await sb.from('brains').select('id, markdown, revision')
  if (error) throw new Error(`brains select failed: ${error.message}`)
  let touched = 0
  for (const row of rows || []) {
    const brain = parseBrain(row.markdown || '')
    const { removed } = pruneSystemPlaceholders(brain)
    if (removed === 0) {
      console.log(`[skip] ${row.id}: nothing to prune`)
      continue
    }
    const nextRevision = (row.revision || 0) + 1
    brain.frontmatter.revision = nextRevision
    brain.frontmatter.updated = new Date().toISOString()
    const markdown = serializeBrain(brain)
    const { error: updateErr } = await sb
      .from('brains')
      .update({ markdown, revision: nextRevision, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    if (updateErr) {
      console.error(`[fail] ${row.id}: ${updateErr.message}`)
      continue
    }
    await sb.from('brain_revisions').insert({
      brain_id: row.id,
      revision: nextRevision,
      operation: 'replace',
      diff: `prune ${removed} system placeholder(s)`,
      author: 'system:prune-placeholders',
    })
    console.log(`[ok]   ${row.id}: pruned ${removed} placeholder(s) → revision ${nextRevision}`)
    touched++
  }
  console.log(`\nDone. Touched ${touched}/${(rows || []).length} brain(s).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
