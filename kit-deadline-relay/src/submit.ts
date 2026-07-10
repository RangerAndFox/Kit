// @ts-nocheck
/**
 * Turn one Kit render request (an ae_render parent) into Deadline jobs:
 *   1. PREPARE: script AfterFX on this box — capture each queued item's real
 *      output module (the deliverable format), override it to a PNG sequence
 *      (Deadline can only frame-split sequences), queue a WAV duplicate for
 *      audible comps, save a __kitfarm.aep farm copy.
 *   2. Per comp: submit a Deadline job rendering the farm copy's PNG sequence
 *      into <projectDir>\render\<comp>\frames\ (ChunkSize-split).
 *   3. Render each comp's audio WAV locally (aerender; can't be frame-split).
 *   4. poll.ts assembles frames+audio → the artist's original format when the
 *      Deadline job completes.
 *
 * Files live on the production SAN (\\thewire\production\...); drive letters
 * are normalized to UNC so headless Workers resolve them.
 */

import * as path from 'path'
import { config } from './config'
import { prepareProject } from './inspect'
import { toFarmPath, farmDirname, farmBasename } from './path-map'
import { writeInfoFiles } from './job-info'
import { submitJob } from './deadline'
import { renderAudioWav } from './audio'

export interface SubmittedJob {
  comp: string
  deadline_job_id: string
  frames: string
  frame_start: number
  fps: number
  is_movie: boolean            // true = OM couldn't be forced to a sequence; rendered whole, no assemble
  output_dir: string           // final deliverable dir
  frames_dir: string
  frame_pattern: string        // ffmpeg-style, e.g. Comp_%05d.png
  audio_wav: string | null
  original_output_name: string
  output_settings_raw: string
  farm_project: string
  status: 'active'
  assembled?: boolean
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'comp'
}

export async function submitParent(parent: any): Promise<{ jobs: SubmittedJob[]; itemCount: number }> {
  const inputPath = parent.ae_project_path
  if (!inputPath) throw new Error('parent has no ae_project_path')
  const farmProject = toFarmPath(inputPath)

  // 1. Prepare: capture OMs, force PNG sequences, queue audio passes, save farm copy.
  const prep = await prepareProject(config.afterfxPath, farmProject)
  if (!prep.items.length) {
    throw new Error('No QUEUED items in the project render queue. Queue at least one item in After Effects and re-submit.')
  }

  const projectDir = farmDirname(farmProject)
  const projectName = farmBasename(farmProject).replace(/\.aep$/i, '')

  const jobs: SubmittedJob[] = []
  for (const item of prep.items) {
    const safeComp = sanitize(item.comp)
    const outputDirFarm = `${projectDir}\\render\\${safeComp}`

    // Sequence render when the OM override worked; whole-movie fallback (the
    // artist's own OM, unsplit) when it didn't — assemble is skipped there.
    const isMovie = !item.sequenceOk
    const framesDir = `${outputDirFarm}\\frames`
    const aeOutputName = isMovie
      ? (item.originalOutputName || `${safeComp}.mov`)
      : `${safeComp}_[#####].png`
    const outputFarmPath = isMovie
      ? `${outputDirFarm}\\${aeOutputName}`
      : `${framesDir}\\${aeOutputName}`

    const { jobInfoPath, pluginInfoPath } = writeInfoFiles({
      jobName: `${projectName} — ${item.comp}`,
      batchName: projectName,
      comp: item.comp,
      sceneFileFarmPath: prep.farmProjectPath,
      outputFarmPath,
      outputDirFarm: isMovie ? outputDirFarm : framesDir,
      outputName: aeOutputName,
      frameStart: item.frameStart,
      frameEnd: item.frameEnd,
      isMovie,
    })

    const jobId = await submitJob(jobInfoPath, pluginInfoPath)
    console.log(`[submit] ${item.comp} → Deadline job ${jobId} (${item.frameStart}-${item.frameEnd}${isMovie ? ', whole movie' : ''})`)

    // 3. Audio pass — local, serialized (aerender is fast for audio-only).
    let audioWav: string | null = null
    if (!isMovie && item.audioRqindex != null) {
      audioWav = `${outputDirFarm}\\${safeComp}_audio.wav`
      try {
        await renderAudioWav(prep.farmProjectPath, item.audioRqindex, audioWav)
        console.log(`[submit] ${item.comp}: audio pass done → ${audioWav}`)
      } catch (err: any) {
        console.error(`[submit] ${item.comp}: audio pass failed (assembling silent): ${err.message}`)
        audioWav = null
      }
    }

    jobs.push({
      comp: item.comp,
      deadline_job_id: jobId,
      frames: `${item.frameStart}-${item.frameEnd}`,
      frame_start: item.frameStart,
      fps: item.fps,
      is_movie: isMovie,
      output_dir: outputDirFarm,
      frames_dir: framesDir,
      frame_pattern: `${safeComp}_%05d.png`,
      audio_wav: audioWav,
      original_output_name: item.originalOutputName || `${safeComp}.mov`,
      output_settings_raw: item.outputSettingsRaw || '',
      farm_project: prep.farmProjectPath,
      status: 'active',
    })
  }

  return { jobs, itemCount: prep.items.length }
}
