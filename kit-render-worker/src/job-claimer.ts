// @ts-nocheck
/**
 * Atomic job claim — picks one pending job and marks it claimed by this worker.
 *
 * Uses RPC-style raw SQL through Supabase's PostgREST + service-role key.
 * For atomicity we rely on UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)
 * which Postgres handles natively.
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
  source_files: any[]
  profile_snapshot: any
  naming_fields: Record<string, string> | null
  slack_channel: string | null
  slack_thread_ts: string | null
}

export async function tryClaimJob(): Promise<ClaimedJob | null> {
  // Fallback workers: pre-flight system checks
  if (config.role !== 'primary') {
    const sys = await readSystemSnapshot()
    if (sys.cpuPercent > config.cpuThreshold) return null
    if (sys.diskFreeGb < config.minDiskFreeGb) return null
  }

  // For fallback workers we add a created_at age constraint so we don't
  // race against the primary on fresh jobs. Encoded as a raw `rpc`-style
  // call via PostgREST's UPDATE...WHERE id IN (SELECT ...) construct.
  //
  // PostgREST doesn't expose FOR UPDATE SKIP LOCKED directly, so we rely on
  // an atomic UPDATE with a returning clause. Two workers attempting the same
  // job will both succeed at most once because UPDATE is atomic and the
  // status flip is the dedup.

  const ageThresholdIso = config.role === 'primary'
    ? null
    : new Date(Date.now() - config.fallbackDelaySeconds * 1000).toISOString()

  // Find oldest pending job
  let query = supabase
    .from('render_jobs')
    .select('id')
    .eq('status', 'pending')
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
    .select('id, source_files, profile_snapshot, naming_fields, slack_channel, slack_thread_ts')
    .maybeSingle()

  if (claimErr) {
    console.error('[claim] update failed:', claimErr.message)
    return null
  }
  if (!claimed) return null // someone else got it
  return claimed as ClaimedJob
}
