// @ts-nocheck
/**
 * Poll the Deadline jobs a parent submitted and roll their state up into the
 * render_jobs row. When a comp's PNG-sequence job completes, run the ASSEMBLE
 * step (frames + audio → the artist's original output format) before counting
 * it done — the parent is complete only when every comp is assembled.
 */

import { getJobStatus } from './deadline'
import { updateParent } from './storage'
import { assembleComp } from './assemble'

export async function pollParent(parent: any): Promise<void> {
  const jobs = Array.isArray(parent.deadline_jobs) ? parent.deadline_jobs : []
  if (jobs.length === 0) return

  let changed = false
  for (const j of jobs) {
    if (j.status === 'completed' || j.status === 'failed') continue
    try {
      const s = await getJobStatus(j.deadline_job_id)
      if (s === 'failed') { j.status = 'failed'; changed = true; continue }
      if (s !== 'completed') continue

      // Deadline finished the frames — assemble unless it was a whole-movie
      // fallback (which already rendered in the artist's own format).
      if (!j.is_movie && !j.assembled) {
        try {
          const finalPath = await assembleComp(j)
          j.assembled = true
          j.final_output = finalPath
          console.log(`[poll] ${j.comp}: assembled → ${finalPath}`)
        } catch (err: any) {
          j.status = 'failed'
          j.error = `assemble failed: ${err.message}`
          changed = true
          console.error(`[poll] ${j.comp}: ${j.error}`)
          continue
        }
      }
      j.status = 'completed'
      changed = true
    } catch (err: any) {
      console.error(`[poll] job ${j.deadline_job_id} status check failed:`, err.message)
    }
  }

  const total = jobs.length
  const completed = jobs.filter((j) => j.status === 'completed').length
  const failed = jobs.filter((j) => j.status === 'failed').length
  const terminal = completed + failed
  const percent = Math.round((completed / total) * 100)

  if (terminal === total) {
    if (failed > 0) {
      const reasons = jobs.filter((j) => j.error).map((j) => `${j.comp}: ${j.error}`).join('; ')
      await updateParent(parent.id, {
        status: 'failed',
        deadline_jobs: jobs,
        error_message: reasons || `${failed}/${total} Deadline job(s) failed`,
        progress_percent: percent,
        progress_message: `Render finished with ${failed} failed comp(s)`,
      })
      console.log(`[poll] parent ${parent.id} FAILED (${failed}/${total})`)
    } else {
      const outputs = jobs.map((j) => j.final_output).filter(Boolean)
      await updateParent(parent.id, {
        status: 'complete',
        completed_at: new Date().toISOString(),
        deadline_jobs: jobs,
        output_path: outputs[0] || null,
        progress_percent: 100,
        progress_message: `Render complete — ${total} comp(s) rendered + assembled`,
      })
      console.log(`[poll] parent ${parent.id} COMPLETE (${total} comps)`)
    }
    return
  }

  if (changed) {
    await updateParent(parent.id, {
      deadline_jobs: jobs,
      progress_percent: percent,
      progress_message: `Rendering on Deadline — ${completed}/${total} comp(s) done`,
    })
  }
}
