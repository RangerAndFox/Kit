// @ts-nocheck
/**
 * Poll the Deadline jobs a parent submitted and roll their state up into the
 * render_jobs row (progress %, completion, failure) so `/kit render status`
 * reflects the farm. Progress is per-comp granular: completed jobs / total.
 */

import { getJobStatus } from './deadline'
import { updateParent } from './storage'

export async function pollParent(parent: any): Promise<void> {
  const jobs = Array.isArray(parent.deadline_jobs) ? parent.deadline_jobs : []
  if (jobs.length === 0) return

  let changed = false
  for (const j of jobs) {
    if (j.status === 'completed' || j.status === 'failed') continue
    try {
      const s = await getJobStatus(j.deadline_job_id)
      if (s === 'completed' && j.status !== 'completed') { j.status = 'completed'; changed = true }
      else if (s === 'failed' && j.status !== 'failed') { j.status = 'failed'; changed = true }
      // 'active'/'unknown' → leave as-is
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
      await updateParent(parent.id, {
        status: 'failed',
        deadline_jobs: jobs,
        error_message: `${failed}/${total} Deadline job(s) failed`,
        progress_percent: percent,
        progress_message: `Render finished with ${failed} failed comp(s)`,
      })
      console.log(`[poll] parent ${parent.id} FAILED (${failed}/${total})`)
    } else {
      await updateParent(parent.id, {
        status: 'complete',
        completed_at: new Date().toISOString(),
        deadline_jobs: jobs,
        progress_percent: 100,
        progress_message: `Render complete — ${total} comp(s) rendered on Deadline`,
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
