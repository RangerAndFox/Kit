// @ts-nocheck
/**
 * Staff ↔ Harvest sync.
 *
 * Backfills staff.harvest_user_id by matching each active staff row's email
 * (and email_aliases) against active Harvest users. This is the data
 * prerequisite for the entire time-tracking suite — the 5pm check-in,
 * missing-time monitor, and ad-hoc logging all skip anyone without a
 * harvest_user_id (the audit found ALL staff unmapped and the features
 * silently inert).
 *
 * Exposed as `/kit sync-staff` (admin) so it never requires a laptop with
 * env vars again; bolt/scripts/sync-staff.ts remains the full-import path
 * for bootstrapping brand-new staff rows from Slack.
 */

import { listUsers as listHarvestUsers } from '../harvest/client'
import { createAdminClient } from '../supabase/admin'

export interface StaffSyncResult {
  updated: { name: string; email: string; harvestId: number }[]
  alreadyMapped: number
  unmatched: { name: string; email: string }[]
}

export async function syncStaffHarvestIds(): Promise<StaffSyncResult> {
  const harvestUsers = await listHarvestUsers()
  const harvestByEmail = new Map<string, (typeof harvestUsers)[number]>()
  for (const h of harvestUsers) {
    if (h.email) harvestByEmail.set(h.email.trim().toLowerCase(), h)
  }

  const sb = createAdminClient()
  const { data: staff, error } = await sb
    .from('staff')
    .select('id, full_name, email, email_aliases, harvest_user_id')
    .eq('is_active', true)
  if (error) throw new Error(`load staff failed: ${error.message}`)

  const result: StaffSyncResult = { updated: [], alreadyMapped: 0, unmatched: [] }

  for (const s of staff || []) {
    if (s.harvest_user_id) {
      result.alreadyMapped++
      continue
    }
    const candidates = [s.email, ...(s.email_aliases || [])]
      .filter(Boolean)
      .map((e: string) => e.trim().toLowerCase())
    const match = candidates.map((e) => harvestByEmail.get(e)).find(Boolean)
    if (!match) {
      result.unmatched.push({ name: s.full_name || '(unnamed)', email: s.email || '—' })
      continue
    }
    const { error: upErr } = await sb
      .from('staff')
      .update({ harvest_user_id: match.id, updated_at: new Date().toISOString() })
      .eq('id', s.id)
    if (upErr) {
      console.warn(`[staff-sync] update failed for ${s.email}: ${upErr.message}`)
      result.unmatched.push({ name: s.full_name || '(unnamed)', email: s.email || '—' })
      continue
    }
    result.updated.push({
      name: s.full_name || '(unnamed)',
      email: s.email || '—',
      harvestId: match.id,
    })
  }

  return result
}
