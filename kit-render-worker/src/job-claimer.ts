// @ts-nocheck
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

import { supabase } from './supabase'
import { config } from './config'
import { readSystemSnapshot } from './system/cpu-monitor'

export interface ClaimedJob {
  id: string
  job_type: 'transcode' | 'ae_chunk' | 'ae_stitch'
  source_files: any[]
  profile_snapshot: any
  naming_fields: Record<string, string> | null
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
  delivery_profile_id: string | null
  output_filename: string | null
}

const CLAIM_FIELDS =
  'id, job_type, source_files, profile_snapshot, naming_fields, slack_channel, slack_thread_ts, ' +
  'parent_job_id, chunk_index, chunk_count, frame_start, frame_end, total_frames, frame_rate, ' +
  'ae_project_path, ae_comp, ae_render_settings_template, ae_output_module_template, ' +
  'ae_output_pattern, ae_output_dir, delivery_profile_id, output_filename'

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
  const claimableTypes = config.aeCapable
    ? ['transcode', 'ae_chunk', 'ae_stitch']
    : ['transcode', 'ae_stitch']

  // Find oldest pending job of a type this worker can run
  let query = supabase
    .from('render_jobs')
    .select('id')
    .eq('status', 'pending')
    .in('job_type', claimableTypes)
    .order('created_at', { ascending: true })
    .limit(1)
  if (ageThresholdIso) {
    query = query.lt('created_at', ageThresholdIso)
  }

  const { data: candidates } = await query
  if (!candidates || candidates.length === 0) return null
  const candidateId = candidates[0].id

  // Attempt to claim. The .eq('status','pending') in the update ensures we
  // only succeed if no other worker beat us to it.
  const { data: claimed, error: claimErr } = await supabase
    .from('render_jobs')
    .update({
      status: 'claimed',
      claimed_by: config.hostname,
      claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', candidateId)
    .eq('status', 'pending')
    .select(CLAIM_FIELDS)
    .maybeSingle()

  if (claimErr) {
    console.error('[claim] update failed:', claimErr.message)
    return null
  }
  if (!claimed) return null // someone else got it
  return claimed as ClaimedJob
}
