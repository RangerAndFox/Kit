import { config } from './config.js'
import { supabase } from './supabase.js'
import type {
  BehanceDraftJob,
  BehanceJobStatus,
  ElevenLabsJobStatus,
  ElevenLabsStudioJob,
} from './types.js'

const now = () => new Date().toISOString()

export async function heartbeat(
  status: 'idle' | 'working' | 'needs_login' | 'error',
  jobId?: string | null,
  error?: string | null,
  browserVersion?: string | null,
): Promise<void> {
  const { error: writeError } = await supabase.from('behance_workers').upsert({
    worker_id: config.workerId,
    display_name: config.displayName,
    status,
    current_job_id: jobId || null,
    last_error: error || null,
    ...(browserVersion ? { browser_version: browserVersion } : {}),
    last_seen_at: now(),
    updated_at: now(),
  }, { onConflict: 'worker_id' })
  if (writeError) throw new Error(`Worker heartbeat failed: ${writeError.message}`)
}

export async function claimNextJob(): Promise<BehanceDraftJob | null> {
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString()
  await supabase.from('behance_draft_jobs').update({
    status: 'retryable', claimed_by: null, claimed_at: null, error: 'Worker heartbeat expired; queued for recovery.', updated_at: now(),
  }).in('status', ['claimed', 'opening_editor', 'uploading_media', 'filling_details', 'saving_draft']).lt('heartbeat_at', staleBefore)

  const { data: candidates, error: readError } = await supabase.from('behance_draft_jobs')
    .select('id,attempt').in('status', ['queued', 'retryable']).order('created_at', { ascending: true }).limit(1)
  if (readError) throw new Error(`Behance queue read failed: ${readError.message}`)
  if (!candidates?.length) return null

  const claimedAt = now()
  const { data, error } = await supabase.from('behance_draft_jobs').update({
    status: 'claimed', claimed_by: config.workerId, claimed_at: claimedAt, heartbeat_at: claimedAt,
    attempt: Number(candidates[0].attempt || 0) + 1,
    started_at: now(), completed_at: null, error: null, updated_at: now(),
  }).eq('id', candidates[0].id).in('status', ['queued', 'retryable']).select('*').maybeSingle()
  if (error) throw new Error(`Behance claim failed: ${error.message}`)
  return data as BehanceDraftJob | null
}

export async function updateJob(job: Pick<BehanceDraftJob, 'id' | 'claimed_at'>, status: BehanceJobStatus, patch: Record<string, unknown> = {}): Promise<void> {
  const terminal = status === 'awaiting_review' || status === 'failed' || status === 'cancelled'
  const { data, error } = await supabase.from('behance_draft_jobs').update({
    status,
    heartbeat_at: now(),
    updated_at: now(),
    ...(terminal ? { completed_at: now() } : {}),
    ...patch,
  }).eq('id', job.id).eq('claimed_by', config.workerId).eq('claimed_at', job.claimed_at).select('id')
  if (error) throw new Error(`Behance job update failed: ${error.message}`)
  if (!data?.length) throw new Error('Behance job claim was lost; stale attempt blocked.')
}

export async function pulseJob(job: Pick<BehanceDraftJob, 'id' | 'claimed_at'>): Promise<void> {
  const { data, error } = await supabase.from('behance_draft_jobs').update({ heartbeat_at: now(), updated_at: now() })
    .eq('id', job.id).eq('claimed_by', config.workerId).eq('claimed_at', job.claimed_at).select('id')
  if (error) throw new Error(`Behance job heartbeat failed: ${error.message}`)
  if (!data?.length) throw new Error('Behance job claim was lost; stale heartbeat blocked.')
}

export async function elevenLabsHeartbeat(
  status: 'idle' | 'working' | 'needs_login' | 'error',
  jobId?: string | null,
  error?: string | null,
  browserVersion?: string | null,
): Promise<void> {
  const { error: writeError } = await supabase.from('elevenlabs_workers').upsert({
    worker_id: config.workerId,
    display_name: config.displayName,
    status,
    current_job_id: jobId || null,
    last_error: error || null,
    ...(browserVersion ? { browser_version: browserVersion } : {}),
    last_seen_at: now(),
    updated_at: now(),
  }, { onConflict: 'worker_id' })
  if (writeError) throw new Error(`ElevenLabs worker heartbeat failed: ${writeError.message}`)
}

export async function claimNextElevenLabsJob(): Promise<ElevenLabsStudioJob | null> {
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString()
  await supabase.from('elevenlabs_studio_jobs').update({
    status: 'retryable', claimed_by: null, claimed_at: null, error: 'Worker heartbeat expired; queued for recovery.', updated_at: now(),
  }).in('status', ['claimed', 'opening_studio', 'filling_project', 'saving_draft']).lt('heartbeat_at', staleBefore)

  const { data: candidates, error: readError } = await supabase.from('elevenlabs_studio_jobs')
    .select('id,attempt').in('status', ['queued', 'retryable']).order('created_at', { ascending: true }).limit(1)
  if (readError) throw new Error(`ElevenLabs queue read failed: ${readError.message}`)
  if (!candidates?.length) return null

  const claimedAt = now()
  const { data, error } = await supabase.from('elevenlabs_studio_jobs').update({
    status: 'claimed', claimed_by: config.workerId, claimed_at: claimedAt, heartbeat_at: claimedAt,
    attempt: Number(candidates[0].attempt || 0) + 1,
    started_at: now(), completed_at: null, error: null, updated_at: now(),
  }).eq('id', candidates[0].id).in('status', ['queued', 'retryable']).select('*').maybeSingle()
  if (error) throw new Error(`ElevenLabs claim failed: ${error.message}`)
  return data as ElevenLabsStudioJob | null
}

export async function updateElevenLabsJob(
  job: Pick<ElevenLabsStudioJob, 'id' | 'claimed_at'>,
  status: ElevenLabsJobStatus,
  patch: Record<string, unknown> = {},
): Promise<void> {
  const terminal = ['complete', 'failed', 'cancelled'].includes(status)
  const { data, error } = await supabase.from('elevenlabs_studio_jobs').update({
    status,
    heartbeat_at: now(),
    updated_at: now(),
    ...(terminal ? { completed_at: now() } : {}),
    ...patch,
  }).eq('id', job.id).eq('claimed_by', config.workerId).eq('claimed_at', job.claimed_at).select('id')
  if (error) throw new Error(`ElevenLabs job update failed: ${error.message}`)
  if (!data?.length) throw new Error('ElevenLabs job claim was lost; stale attempt blocked.')
}

export async function pulseElevenLabsJob(job: Pick<ElevenLabsStudioJob, 'id' | 'claimed_at'>): Promise<void> {
  const { data, error } = await supabase.from('elevenlabs_studio_jobs')
    .update({ heartbeat_at: now(), updated_at: now() })
    .eq('id', job.id).eq('claimed_by', config.workerId).eq('claimed_at', job.claimed_at).select('id')
  if (error) throw new Error(`ElevenLabs job heartbeat failed: ${error.message}`)
  if (!data?.length) throw new Error('ElevenLabs job claim was lost; stale heartbeat blocked.')
}

export async function completeStoryboardElevenLabs(
  job: Pick<ElevenLabsStudioJob, 'id' | 'claimed_at'>,
  projectId: string,
  url: string,
): Promise<void> {
  const { data, error } = await supabase.rpc('complete_elevenlabs_studio_job' as any, {
    p_job_id: job.id,
    p_worker_id: config.workerId,
    p_claimed_at: job.claimed_at,
    p_project_id: projectId,
    p_url: url,
  } as any)
  if (error) throw new Error(`Storyboard ElevenLabs completion failed: ${error.message}`)
  if (!data) throw new Error('ElevenLabs job claim was lost; stale completion blocked.')
}

export async function failStoryboardElevenLabs(storyboardJobId: string, errorMessage: string): Promise<void> {
  const { error } = await supabase.from('storyboard_jobs').update({
    elevenlabs_status: 'failed',
    elevenlabs_error: errorMessage.slice(0, 1000),
    updated_at: now(),
  }).eq('id', storyboardJobId)
  if (error) throw new Error(`Storyboard ElevenLabs failure checkpoint failed: ${error.message}`)
}
