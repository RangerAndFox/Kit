// @ts-nocheck
/**
 * Turn one Kit render request (an ae_render parent) into Deadline jobs:
 *   1. Read the project's render queue (AfterFX on this relay box).
 *   2. For each QUEUED comp, build a Deadline AE job — image sequences are
 *      frame-split via ChunkSize, single movies render whole.
 *   3. Submit via deadlinecommand, collecting the JobIDs.
 *
 * Files live on the production SAN (e.g. \\thewire\production\...). The .aep path
 * is passed straight through to Deadline (drive letters like Z: normalized to
 * UNC so headless Workers resolve them); output is written next to the project
 * at <projectDir>\render\<comp>\.
 */

import { config } from './config'
import { inspectRenderQueue } from './inspect'
import { toFarmPath, farmDirname, farmBasename } from './path-map'
import { writeInfoFiles } from './job-info'
import { submitJob } from './deadline'

export interface SubmittedJob {
  comp: string
  deadline_job_id: string
  frames: string
  is_movie: boolean
  output_dir: string   // farm output dir (for reference)
  status: 'active'
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'comp'
}

export async function submitParent(parent: any): Promise<{ jobs: SubmittedJob[]; itemCount: number }> {
  const inputPath = parent.ae_project_path
  if (!inputPath) throw new Error('parent has no ae_project_path')

  // Normalize drive letters (Z:\...) to UNC so headless Workers resolve them;
  // UNC paths pass through unchanged.
  const farmProject = toFarmPath(inputPath)

  // Read the render queue off the same SAN the farm renders from.
  const queue = await inspectRenderQueue(config.afterfxPath, farmProject)
  if (!queue.items.length) {
    throw new Error('No QUEUED items in the project render queue. Queue at least one item in After Effects and re-submit.')
  }

  const projectDir = farmDirname(farmProject)                       // \\thewire\production\...\<job>
  const projectName = farmBasename(farmProject).replace(/\.aep$/i, '')

  const jobs: SubmittedJob[] = []
  for (const item of queue.items) {
    const safeComp = sanitize(item.comp)
    const outputDirFarm = `${projectDir}\\render\\${safeComp}`      // beside the project on the SAN
    const outputName = item.outputName || (item.isSequence ? `${safeComp}_[#####].png` : `${safeComp}.mov`)
    const outputFarmPath = `${outputDirFarm}\\${outputName}`

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
      output_dir: outputDirFarm,
      status: 'active',
    })
    console.log(`[submit] ${item.comp} → Deadline job ${jobId} (${item.frameStart}-${item.frameEnd})`)
  }

  return { jobs, itemCount: queue.items.length }
}
