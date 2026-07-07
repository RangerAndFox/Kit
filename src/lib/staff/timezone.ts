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

export async function staffTimezone(slackUserId?: string | null): Promise<string> {
  if (!slackUserId) return studioTimezone()
  try {
    const sb = createAdminClient()
    const { data } = await sb
      .from('staff')
      .select('timezone')
      .eq('slack_user_id', slackUserId)
      .maybeSingle()
    if (data?.timezone && TZ_RE.test(data.timezone)) return data.timezone
  } catch {
    /* fall through */
  }
  return studioTimezone()
}
