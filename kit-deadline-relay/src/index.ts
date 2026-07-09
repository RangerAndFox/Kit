// @ts-nocheck
/**
 * Kit → Deadline relay entry point.
 *
 * On each tick: claim any new Deadline-backed render request, read its render
 * queue, submit one Deadline job per queued comp, then poll everything this
 * relay has in flight and roll status back to Supabase (→ /kit render status).
 *
 * Reuses the existing Kit render queue (render_jobs). No worker is installed on
 * the render nodes — Deadline's own Workers do the rendering.
 */

import { config } from './config'
import { claimParent, listActiveSubmitted, updateParent } from './storage'
import { submitParent } from './submit'
import { pollParent } from './poll'

console.log('═══════════════════════════════════════════════════════')
console.log(' Kit Deadline Relay')
console.log(`  Relay host:  ${config.hostname}`)
console.log(`  deadlinecmd: ${config.deadlineCommand}`)
console.log(`  AfterFX:     ${config.afterfxPath || '(not set — cannot inspect!)'}`)
console.log(`  Pool/Group:  ${config.pool} / ${config.group}   Priority ${config.priority}`)
console.log(`  AE version:  ${config.aeVersion}   ChunkSize ${config.chunkSize}`)
console.log(`  Path map:    ${config.pathMap || '(none set — farm paths will be wrong!)'}`)
console.log('═══════════════════════════════════════════════════════')

async function tick(): Promise<void> {
  // 1. Claim + submit one new render (one per tick keeps AfterFX serialized).
  const parent = await claimParent()
  if (parent) {
    console.log(`[relay] claimed render ${parent.id} (${parent.ae_project_path})`)
    try {
      const { jobs, itemCount } = await submitParent(parent)
      await updateParent(parent.id, {
        deadline_jobs: jobs,
        progress_percent: 0,
        progress_message: `Submitted ${jobs.length} comp(s) from ${itemCount} queued item(s) to Deadline`,
      })
    } catch (err: any) {
      console.error(`[relay] submit failed for ${parent.id}:`, err.message)
      await updateParent(parent.id, { status: 'failed', error_message: `Deadline submit failed: ${err.message}` })
    }
  }

  // 2. Poll everything already submitted.
  const active = await listActiveSubmitted()
  for (const p of active) {
    try {
      await pollParent(p)
    } catch (err: any) {
      console.error(`[relay] poll failed for ${p.id}:`, err.message)
    }
  }
}

async function main(): Promise<void> {
  console.log(`[relay] polling every ${config.pollIntervalMs}ms`)
  while (true) {
    try {
      await tick()
    } catch (err: any) {
      console.error('[relay] tick error:', err.message || err)
    }
    await sleep(config.pollIntervalMs)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('[relay] fatal:', err)
  process.exit(1)
})
