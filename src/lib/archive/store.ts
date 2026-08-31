import { createAdminClient } from '../supabase/admin'
import type { ArchiveJob, ArchiveJobStatus } from './types'

const db = () => createAdminClient() as any
const now = () => new Date().toISOString()

export async function createArchiveJob(input: Omit<ArchiveJob, 'id' | 'status' | 'progress' | 'results' | 'error' | 'attempt' | 'created_at' | 'updated_at'>): Promise<ArchiveJob> {
  const { data, error } = await db().from('archive_jobs').insert({
    ...input,
    status: 'awaiting_confirmation',
    progress: {},
    results: {},
    attempt: 0,
    updated_at: now(),
  }).select('*').single()
  if (error?.code === '23505') {
    const { data: existing, error: readError } = await db().from('archive_jobs').select('*').eq('idempotency_key', input.idempotency_key).single()
    if (readError || !existing) throw new Error(`archive job replay read failed: ${readError?.message || 'no row returned'}`)
    return existing as ArchiveJob
  }
  if (error || !data) throw new Error(`archive job create failed: ${error?.message || 'no row returned'}`)
  return data as ArchiveJob
}

export async function getArchiveJob(id: string): Promise<ArchiveJob | null> {
  const { data, error } = await db().from('archive_jobs').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`archive job read failed: ${error.message}`)
  return data as ArchiveJob | null
}

export async function listRecoverableArchiveJobs(leaseSeconds = 7200): Promise<ArchiveJob[]> {
  const cutoff = new Date(Date.now() - leaseSeconds * 1000).toISOString()
  const { data, error } = await db().from('archive_jobs')
    .select('*')
    .in('status', ['queued', 'validating', 'preparing_media', 'uploading_vimeo', 'creating_wordpress', 'creating_buffer', 'preparing_behance'])
    .or(`claim_token.is.null,claimed_at.lt.${cutoff}`)
    .order('updated_at', { ascending: true })
    .limit(25)
  if (error) throw new Error(`recoverable archive job scan failed: ${error.message}`)
  return (data || []) as ArchiveJob[]
}

export async function updateArchiveJob(id: string, patch: Partial<ArchiveJob> & { status?: ArchiveJobStatus }): Promise<ArchiveJob> {
  const { data, error } = await db().from('archive_jobs').update({ ...patch, updated_at: now() }).eq('id', id).select('*').single()
  if (error || !data) throw new Error(`archive job update failed: ${error?.message || 'no row returned'}`)
  return data as ArchiveJob
}

export async function acquireArchiveJobLease(id: string, workerId: string): Promise<ArchiveJob | null> {
  const { data, error } = await db().rpc('acquire_archive_job_lease', {
    p_job_id: id,
    p_worker_id: workerId,
    p_lease_seconds: 7200,
  })
  if (error) throw new Error(`archive job lease failed: ${error.message}`)
  return (data?.[0] || null) as ArchiveJob | null
}

export async function updateClaimedArchiveJob(
  id: string,
  claimToken: string,
  patch: Partial<ArchiveJob> & { status?: ArchiveJobStatus },
): Promise<ArchiveJob> {
  const { data, error } = await db().from('archive_jobs')
    .update({ ...patch, updated_at: now() })
    .eq('id', id)
    .eq('claim_token', claimToken)
    .select('*')
    .maybeSingle()
  if (error) throw new Error(`claimed archive job update failed: ${error.message}`)
  if (!data) throw new Error('archive job lease was lost')
  return data as ArchiveJob
}

export async function claimArchiveJob(id: string): Promise<ArchiveJob | null> {
  const current = await getArchiveJob(id)
  if (!current || current.status !== 'awaiting_confirmation') return null
  const { data, error } = await db().from('archive_jobs').update({
    status: 'queued',
    attempt: Number(current.attempt || 0) + 1,
    started_at: now(),
    error: null,
    updated_at: now(),
  }).eq('id', id).eq('status', 'awaiting_confirmation').select('*').maybeSingle()
  if (error) throw new Error(`archive job claim failed: ${error.message}`)
  return data as ArchiveJob | null
}

export async function requeueArchiveJob(id: string): Promise<ArchiveJob | null> {
  const current = await getArchiveJob(id)
  if (!current || !['failed', 'partial'].includes(current.status)) return null
  const { data, error } = await db().from('archive_jobs').update({
    status: 'queued', attempt: Number(current.attempt || 0) + 1,
    error: null, completed_at: null, updated_at: now(),
    progress: { message: 'Retry queued; completed steps will not be repeated.' },
  }).eq('id', id).eq('status', current.status).select('*').maybeSingle()
  if (error) throw new Error(`archive job requeue failed: ${error.message}`)
  return data as ArchiveJob | null
}

export async function saveArchiveSlackMessage(id: string, channelId: string, messageTs: string): Promise<void> {
  await updateArchiveJob(id, { slack_channel_id: channelId, slack_message_ts: messageTs } as any)
}

export async function getArchiveStep(jobId: string, stepName: string): Promise<any | null> {
  const { data, error } = await db().from('archive_job_steps').select('*').eq('job_id', jobId).eq('step_name', stepName).maybeSingle()
  if (error) throw new Error(`archive step read failed: ${error.message}`)
  return data
}

export async function startArchiveStep(jobId: string, stepName: string, workerId: string): Promise<any | null> {
  const { data, error } = await db().rpc('claim_archive_step', {
    p_job_id: jobId,
    p_step_name: stepName,
    p_worker_id: workerId,
    p_lease_seconds: 7200,
  })
  if (error) throw new Error(`archive step claim failed: ${error.message}`)
  return data?.[0] || null
}

export async function finishArchiveStep(jobId: string, stepName: string, claimToken: string, status: 'complete' | 'failed' | 'skipped', result: any = {}, errorMessage?: string): Promise<void> {
  const { data, error } = await db().rpc('finish_archive_step_fenced', {
    p_job_id: jobId,
    p_step_name: stepName,
    p_claim_token: claimToken,
    p_status: status,
    p_result: result || {},
    p_error: errorMessage || null,
  })
  if (error) throw new Error(`archive step finish failed: ${error.message}`)
  if (!data) throw new Error('archive step lease was lost')
}
