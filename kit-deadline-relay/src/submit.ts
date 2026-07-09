// @ts-nocheck
/**
 * Turn one Kit render request (an ae_render parent) into Deadline jobs:
 *   1. Read the project's render queue (AfterFX on this relay box).
 *   2. For each QUEUED comp, build a Deadline AE job — image sequences are
 *      frame-split via ChunkSize, single movies render whole.
 *   3. Submit via deadlinecommand, collecting the JobIDs.
 *
 * Output is redirected to a shared folder next to the project
 * (<projectDir>/render/<comp>/) so it resolves on every node, mirroring the
 * kit-worker backend.
 */

import { config } from './config'
import { inspectRenderQueue } from './inspect'
import { toFarmPath, dropboxDirname } from './path-map'
import { writeInfoFiles } from './job-info'
import { submitJob } from './deadline'

export interface SubmittedJob {
  comp: string
  deadline_job_id: string
  frames: string
  is_movie: boolean
  output_dir: string   // Dropbox path (for reference / later stitch)
  status: 'active'
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'comp'
}

export async function submitParent(parent: any): Promise<{ jobs: SubmittedJob[]; itemCount: number }> {
  const dropboxProject = parent.ae_project_path
  if (!dropboxProject) throw new Error('parent has no ae_project_path')

  const farmProject = toFarmPath(dropboxProject)

  // Read the render queue from the same share the farm renders from.
  const queue = await inspectRenderQueue(config.afterfxPath, farmProject)
  if (!queue.items.length) {
    throw new Error('No QUEUED items in the project render queue. Queue at least one item in After Effects and re-submit.')
  }

  const projectDir = dropboxDirname(dropboxProject)
  const projectName = (dropboxProject.split('/').pop() || 'project').replace(/\.aep$/i, '')

  const jobs: SubmittedJob[] = []
  for (const item of queue.items) {
    const safeComp = sanitize(item.comp)
    const outputDirDropbox = `${projectDir}/render/${safeComp}`
    const outputDirFarm = toFarmPath(outputDirDropbox)
    const outputName = item.outputName || (item.isSequence ? `${safeComp}_[#####].png` : `${safeComp}.mov`)
    const outputFarmPath = `${outputDirFarm.replace(/\\+$/, '')}\\${outputName}`

    const { jobInfoPath, pluginInfoPath } = writeInfoFiles({
      jobName: `${projectName} — ${item.comp}`,
      batchName: projectName,
      comp: item.comp,
      sceneFileFarmPath: farmProject,
      outputFarmPath,
      outputDirFarm,
      outputName,
      frameStart: item.frameStart,
      frameEnd: item.frameEnd,
      isMovie: !item.isSequence,
    })

    const jobId = await submitJob(jobInfoPath, pluginInfoPath)
    jobs.push({
      comp: item.comp,
      deadline_job_id: jobId,
      frames: `${item.frameStart}-${item.frameEnd}`,
      is_movie: !item.isSequence,
      output_dir: outputDirDropbox,
      status: 'active',
    })
    console.log(`[submit] ${item.comp} → Deadline job ${jobId} (${item.frameStart}-${item.frameEnd})`)
  }

  return { jobs, itemCount: queue.items.length }
}
