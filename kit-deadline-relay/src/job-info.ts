// @ts-nocheck
/**
 * Build the Deadline job-info + plugin-info files for one queued After Effects
 * comp. Written to temp files and handed to `deadlinecommand -SubmitJob`.
 *
 * Parameter names follow the AfterEffects plugin's AfterEffects.param
 * (Deadline 10.2.x): Comp (required), SceneFile, Version, Output, MultiProcess,
 * ContinueOnMissingFootage, IgnoreMissing* ...
 *
 * Frame-splitting is expressed in the JOB info (Frames + ChunkSize); Deadline
 * makes one task per chunk and distributes them. Single-movie outputs use one
 * whole task (ChunkSize >= frame count).
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { config } from './config'

export interface AeJobSpec {
  jobName: string
  comp: string
  sceneFileFarmPath: string   // .aep as the render nodes see it
  outputFarmPath: string      // output incl. AE [#####] padding for sequences
  outputDirFarm: string       // dir portion (for Deadline OutputDirectory0)
  outputName: string          // filename portion (for Deadline OutputFilename0)
  frameStart: number
  frameEnd: number
  isMovie: boolean
  batchName?: string          // groups a project's per-comp jobs in the Monitor
}

function kv(lines: Record<string, string | number>): string {
  return Object.entries(lines)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n'
}

/** Write job-info + plugin-info temp files; returns their paths. */
export function writeInfoFiles(spec: AeJobSpec): { jobInfoPath: string; pluginInfoPath: string } {
  const total = spec.frameEnd - spec.frameStart + 1
  // Movies can't be split; sequences use the configured frames-per-task.
  const chunkSize = spec.isMovie ? Math.max(1, total) : Math.max(1, config.chunkSize)

  const jobInfo = kv({
    Plugin: config.plugin,
    Name: spec.jobName,
    BatchName: spec.batchName || '',
    Comment: 'Submitted by Kit',
    Pool: config.pool,
    Group: config.group,
    Priority: config.priority,
    Frames: `${spec.frameStart}-${spec.frameEnd}`,
    ChunkSize: chunkSize,
    OutputDirectory0: spec.outputDirFarm,
    OutputFilename0: spec.outputName,
  })

  const pluginInfo = kv({
    SceneFile: spec.sceneFileFarmPath,
    Comp: spec.comp,
    Version: config.aeVersion,
    Output: spec.outputFarmPath,
    MultiProcess: 'True',
    ContinueOnMissingFootage: 'True',
    IgnoreMissingLayerDependenciesErrors: 'True',
    IgnoreMissingEffectReferencesErrors: 'True',
    MemoryManagement: 'False',
    LocalRendering: 'False',
    // Must be False so movie outputs don't fail on the missing per-frame
    // "Finished composition" message.
    FailWithoutFinishedMessage: 'False',
  })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-deadline-job-'))
  const jobInfoPath = path.join(tmpDir, 'job_info.txt')
  const pluginInfoPath = path.join(tmpDir, 'plugin_info.txt')
  fs.writeFileSync(jobInfoPath, jobInfo, 'utf8')
  fs.writeFileSync(pluginInfoPath, pluginInfo, 'utf8')
  return { jobInfoPath, pluginInfoPath }
}
