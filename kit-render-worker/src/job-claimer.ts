/**
 * Atomic job claim — picks one pending job and marks it claimed by this worker.
 *
 * Concurrency model: PostgREST doesn't expose FOR UPDATE SKIP LOCKED, so this
 * uses a two-step pattern:
 *   1. SELECT the oldest pending job id (advisory — multiple workers may read
 *      the same id concurrently).
 *   2. UPDATE ... WHERE id = $1 AND status = 'pending'. Postgres takes an
 *      exclusive row lock on the UPDATE; only one worker's predicate matches
 *      (the row's status flips on the first UPDATE, so concurrent UPDATEs
 *      return 0 rows). The losers silently re-poll on the next tick.
 *
 * Pre-claim checks for fallback workers:
 *   - CPU usage below threshold
 *   - Disk free above MIN_DISK_FREE_GB
 *   - Job has been pending for > fallbackDelaySeconds
 * Primary workers skip the delay check and claim immediately.
 */

import { workerRequest } from './api'
import { config } from './config'
import { readSystemSnapshot } from './system/cpu-monitor'

export interface ClaimedJob {
  id: string
  claimed_at: string
  job_type: 'transcode' | 'ae_inspect' | 'ae_chunk' | 'ae_stitch'
  source_files: any[]
  profile_snapshot: any
  naming_fields: Record<string, string> | null
  requested_by: string | null
  slack_channel: string | null
  slack_thread_ts: string | null

  // AE chunk / stitch fields (null on plain transcode jobs)
  parent_job_id: string | null
  chunk_index: number | null
  chunk_count: number | null
  frame_start: number | null
  frame_end: number | null
  total_frames: number | null
  frame_rate: string | null
  ae_project_path: string | null
  ae_comp: string | null
  ae_render_settings_template: string | null
  ae_output_module_template: string | null
  ae_output_pattern: string | null
  ae_output_dir: string | null
  ae_rqindex: number | null
  ae_is_movie: boolean | null
  delivery_profile_id: string | null
  output_filename: string | null
}

export async function tryClaimJob(): Promise<ClaimedJob | null> {
  // Fallback workers: pre-flight system checks
  if (config.role !== 'primary') {
    const sys = await readSystemSnapshot()
    if (sys.cpuPercent > config.cpuThreshold) return null
    if (sys.diskFreeGb < config.minDiskFreeGb) return null
  }

  // For fallback workers we add a created_at age constraint so we don't
  // race against the primary on fresh jobs. The two-step SELECT + UPDATE
  // approach is explained in the module JSDoc above.

  const ageThresholdIso = config.role === 'primary'
    ? null
    : new Date(Date.now() - config.fallbackDelaySeconds * 1000).toISOString()

  // Which job types may this worker run? AE chunks need an aerender binary;
  // every worker can run transcode + stitch (both FFmpeg). The 'ae_render'
  // parent row is a tracker and is never pending, so it's excluded implicitly.
  const result = await workerRequest<{ ok: true; job: ClaimedJob | null }>('render.claim', {
    aeCapable: config.aeCapable,
    ageThresholdIso,
  })
  return result.job
}
