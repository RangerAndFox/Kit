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
  const { data: candidates } = await supabase
    .from('render_jobs')
    .select('id')
    .eq('job_type', 'ae_render')
    .eq('render_backend', 'deadline')
    .eq('status', 'processing')
    .is('claimed_by', null)
    .order('created_at', { ascending: true })
    .limit(1)
  if (!candidates || candidates.length === 0) return null

  const { data: claimed } = await supabase
    .from('render_jobs')
    .update({ claimed_by: config.hostname, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', candidates[0].id)
    .is('claimed_by', null)
    .select('*')
    .maybeSingle()
  return claimed || null // null → another relay beat us to it
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
    .not('deadline_jobs', 'is', null)
  return data || []
}

export async function updateParent(id: string, patch: Record<string, any>): Promise<void> {
  await supabase
    .from('render_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
}
