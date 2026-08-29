// @ts-nocheck
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

export async function updateArchiveJob(id: string, patch: Partial<ArchiveJob> & { status?: ArchiveJobStatus }): Promise<ArchiveJob> {
  const { data, error } = await db().from('archive_jobs').update({ ...patch, updated_at: now() }).eq('id', id).select('*').single()
  if (error || !data) throw new Error(`archive job update failed: ${error?.message || 'no row returned'}`)
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

export async function startArchiveStep(jobId: string, stepName: string): Promise<void> {
  const previous = await getArchiveStep(jobId, stepName)
  const { error } = await db().from('archive_job_steps').upsert({
    job_id: jobId,
    step_name: stepName,
    status: 'running',
    attempt: Number(previous?.attempt || 0) + 1,
    error: null,
    started_at: now(),
    completed_at: null,
    updated_at: now(),
  }, { onConflict: 'job_id,step_name' })
  if (error) throw new Error(`archive step start failed: ${error.message}`)
}

export async function finishArchiveStep(jobId: string, stepName: string, status: 'complete' | 'failed' | 'skipped', result: any = {}, errorMessage?: string): Promise<void> {
  const { error } = await db().from('archive_job_steps').update({
    status,
    result: result || {},
    error: errorMessage || null,
    completed_at: now(),
    updated_at: now(),
  }).eq('job_id', jobId).eq('step_name', stepName)
  if (error) throw new Error(`archive step finish failed: ${error.message}`)
}
