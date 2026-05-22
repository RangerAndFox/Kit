// @ts-nocheck
/**
 * Supabase CRUD for delivery profiles + render jobs + render workers.
 */

import { createAdminClient } from '../supabase/admin'
import type { DeliveryProfile, RenderJobRow, RenderWorkerRow, NamingFields, SourceFile } from './types'

export async function listProfiles(includeArchived = false): Promise<DeliveryProfile[]> {
  const sb = createAdminClient()
  let q = sb.from('delivery_profiles').select('*').order('name')
  if (!includeArchived) q = q.eq('archived', false)
  const { data, error } = await q
  if (error) throw new Error(`listProfiles: ${error.message}`)
  return (data || []) as DeliveryProfile[]
}

export async function getProfile(idOrName: string): Promise<DeliveryProfile | null> {
  const sb = createAdminClient()
  // Try id first (uuid form), then name.
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrName)
  const { data } = await sb
    .from('delivery_profiles')
    .select('*')
    .eq(isUuid ? 'id' : 'name', idOrName)
    .maybeSingle()
  return (data as DeliveryProfile) || null
}

export async function createProfile(input: Partial<DeliveryProfile>): Promise<DeliveryProfile | null> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('delivery_profiles')
    .insert(input)
    .select('*')
    .single()
  if (error) throw new Error(`createProfile: ${error.message}`)
  return data as DeliveryProfile
}

export async function updateProfile(id: string, patch: Partial<DeliveryProfile>): Promise<void> {
  const sb = createAdminClient()
  const { error } = await sb
    .from('delivery_profiles')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(`updateProfile: ${error.message}`)
}

export async function submitJob(input: {
  profileId: string
  sourceFiles: SourceFile[]
  namingFields: NamingFields
  requestedBy: string
  slackChannel?: string
  slackThreadTs?: string
}): Promise<RenderJobRow | null> {
  const sb = createAdminClient()
  const profile = await getProfile(input.profileId)
  if (!profile) throw new Error(`submitJob: profile not found: ${input.profileId}`)

  const { data, error } = await sb
    .from('render_jobs')
    .insert({
      profile_id: input.profileId,
      profile_snapshot: profile,
      source_files: input.sourceFiles,
      naming_fields: input.namingFields,
      requested_by: input.requestedBy,
      slack_channel: input.slackChannel ?? null,
      slack_thread_ts: input.slackThreadTs ?? null,
      status: 'pending',
    })
    .select('*')
    .single()
  if (error) throw new Error(`submitJob: ${error.message}`)
  return data as RenderJobRow
}

export async function getJob(jobId: string): Promise<RenderJobRow | null> {
  const sb = createAdminClient()
  const { data } = await sb.from('render_jobs').select('*').eq('id', jobId).maybeSingle()
  return (data as RenderJobRow) || null
}

export async function listRecentJobs(limit = 25): Promise<RenderJobRow[]> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('render_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data || []) as RenderJobRow[]
}

export async function listWorkers(): Promise<RenderWorkerRow[]> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('render_workers')
    .select('*')
    .order('priority', { ascending: true })
  return (data || []) as RenderWorkerRow[]
}

export async function getWorker(hostname: string): Promise<RenderWorkerRow | null> {
  const sb = createAdminClient()
  const { data } = await sb.from('render_workers').select('*').eq('hostname', hostname).maybeSingle()
  return (data as RenderWorkerRow) || null
}

export async function setWorkerOptOut(hostname: string, optedOutBy: string, reason: string): Promise<void> {
  const sb = createAdminClient()
  await sb
    .from('render_workers')
    .update({
      status: 'opted_out',
      opted_out_by: optedOutBy,
      opted_out_at: new Date().toISOString(),
      opted_out_reason: reason,
    })
    .eq('hostname', hostname)
}

export async function setWorkerOptIn(hostname: string): Promise<void> {
  const sb = createAdminClient()
  await sb
    .from('render_workers')
    .update({
      status: 'offline', // worker's next heartbeat will flip it to online
      opted_out_by: null,
      opted_out_at: null,
      opted_out_reason: null,
    })
    .eq('hostname', hostname)
}

/**
 * Reset stale jobs whose worker hasn't heartbeated in > thresholdSeconds.
 * Returns the number of jobs reset.
 */
export async function resetStaleJobs(thresholdSeconds = 60): Promise<number> {
  const sb = createAdminClient()
  // Find workers with stale heartbeats
  const cutoff = new Date(Date.now() - thresholdSeconds * 1000).toISOString()
  const { data: staleWorkers } = await sb
    .from('render_workers')
    .select('hostname')
    .lt('last_heartbeat', cutoff)
    .eq('status', 'online')

  if (!staleWorkers || staleWorkers.length === 0) return 0

  const hostnames = staleWorkers.map((w: any) => w.hostname)

  // Mark workers offline
  await sb
    .from('render_workers')
    .update({ status: 'offline' })
    .in('hostname', hostnames)

  // Reset claimed/processing jobs back to pending
  const { data: resetJobs } = await sb
    .from('render_jobs')
    .update({
      status: 'pending',
      claimed_by: null,
      claimed_at: null,
      progress_percent: 0,
      progress_message: 'Worker went offline — re-queued',
      updated_at: new Date().toISOString(),
    })
    .in('claimed_by', hostnames)
    .in('status', ['claimed', 'processing'])
    .select('id')

  return resetJobs?.length || 0
}
