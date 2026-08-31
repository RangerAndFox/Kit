// @ts-nocheck
/**
 * Supabase access for the relay. Deadline-backed renders are ae_render parent
 * rows with render_backend='deadline'. The relay claims unclaimed ones, submits
 * Deadline jobs, records them in deadline_jobs, and updates status.
 */

import { supabase } from './supabase'
import { config } from './config'

/** Claim the oldest unclaimed Deadline-backed render. Returns it, or null. */
export async function claimParent(): Promise<any | null> {
  const { data, error } = await supabase.rpc('claim_deadline_parent', {
    p_worker: config.hostname,
    p_lease_seconds: 1800,
  })
  if (error) throw new Error(`Deadline parent claim failed: ${error.message}`)
  return data?.[0] || null
}

/** Renders this relay has submitted that are still in flight. */
export async function listActiveSubmitted(): Promise<any[]> {
  const { data } = await supabase
    .from('render_jobs')
    .select('*')
    .eq('job_type', 'ae_render')
    .eq('render_backend', 'deadline')
    .eq('status', 'processing')
    .eq('claimed_by', config.hostname)
    .gt('deadline_lease_until', new Date().toISOString())
    .not('deadline_jobs', 'is', null)
  return data || []
}

export async function updateParent(id: string, claimToken: string, patch: Record<string, any>): Promise<void> {
  const { data, error } = await supabase
    .from('render_jobs')
    .update({ ...patch, deadline_lease_until: new Date(Date.now() + 1_800_000).toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('deadline_claim_token', claimToken)
    .select('id')
  if (error) throw new Error(`Deadline parent checkpoint failed: ${error.message}`)
  if (!data?.length) throw new Error('Deadline parent lease lost')
}

export async function checkpointSubmittedJob(parent: any, job: any): Promise<void> {
  const current = Array.isArray(parent.deadline_jobs) ? parent.deadline_jobs : []
  const next = [...current.filter((entry: any) => entry.comp !== job.comp), job]
  await updateParent(parent.id, parent.deadline_claim_token, { deadline_jobs: next })
  parent.deadline_jobs = next
}
