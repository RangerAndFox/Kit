// @ts-nocheck
/**
 * Staff timezone lookup for src/lib code, which has no Slack client.
 * staff.timezone is a cache of the Slack profile tz, refreshed by the
 * bolt-side resolver (bolt/src/checkins/user-tz.ts) and /kit sync-staff.
 * Falls back to the studio default when unknown.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { studioTimezone } from '@/lib/time/studio-date'

const TZ_RE = /^[A-Za-z_]+\/[A-Za-z0-9_+-]+$/

export interface StaffProfileLite {
  timezone: string
  harvestUserId: number | null
}

/**
 * The staff fields time logging needs, in one lookup: their timezone (for
 * date anchoring) and their Harvest user id (for entry attribution —
 * without user_id Harvest books entries to the API token owner).
 */
export async function staffProfile(slackUserId?: string | null): Promise<StaffProfileLite> {
  const fallback: StaffProfileLite = { timezone: studioTimezone(), harvestUserId: null }
  if (!slackUserId) return fallback
  try {
    const sb = createAdminClient()
    const { data } = await sb
      .from('staff')
      .select('timezone, harvest_user_id')
      .eq('slack_user_id', slackUserId)
      .maybeSingle()
    return {
      timezone: data?.timezone && TZ_RE.test(data.timezone) ? data.timezone : studioTimezone(),
      harvestUserId: data?.harvest_user_id || null,
    }
  } catch {
    return fallback
  }
}

export async function staffTimezone(slackUserId?: string | null): Promise<string> {
  return (await staffProfile(slackUserId)).timezone
}
