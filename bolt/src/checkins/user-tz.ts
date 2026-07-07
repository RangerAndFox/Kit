// @ts-nocheck
/**
 * Per-person timezone resolution.
 *
 * Source of truth is the Slack profile (users.info → tz), which Slack keeps
 * current automatically when people travel. Resolution order:
 *   1. in-memory cache (12h TTL — the check-in cron runs hourly)
 *   2. Slack users.info (fresh), written back to staff.timezone so src/lib
 *      code without a Slack client can read it
 *   3. staff.timezone (last known)
 *   4. the studio default (CHECKIN_TIMEZONE, America/Los_Angeles)
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { checkinTimezone } from './date'

const TTL_MS = 12 * 60 * 60 * 1000
const cache = new Map<string, { tz: string; at: number }>()

/** Loose IANA-name sanity check ("America/New_York", "Etc/UTC"). */
function looksLikeTz(tz: unknown): tz is string {
  return typeof tz === 'string' && /^[A-Za-z_]+\/[A-Za-z0-9_+-]+$/.test(tz)
}

export async function resolveUserTimezone(opts: {
  app: App
  slackUserId: string
}): Promise<string> {
  const { app, slackUserId } = opts
  const hit = cache.get(slackUserId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tz

  // Fresh from Slack — and persist for the src/lib side.
  try {
    const res = await app.client.users.info({ user: slackUserId })
    const tz = (res.user as any)?.tz
    if (looksLikeTz(tz)) {
      cache.set(slackUserId, { tz, at: Date.now() })
      const sb = createAdminClient()
      sb.from('staff')
        .update({ timezone: tz })
        .eq('slack_user_id', slackUserId)
        .then(({ error }) => {
          if (error) console.warn(`[user-tz] staff write-back failed: ${error.message}`)
        })
      return tz
    }
  } catch (err: any) {
    console.warn(`[user-tz] users.info failed for ${slackUserId}: ${err?.data?.error || err.message}`)
  }

  // Last known value from the staff row.
  try {
    const sb = createAdminClient()
    const { data } = await sb
      .from('staff')
      .select('timezone')
      .eq('slack_user_id', slackUserId)
      .maybeSingle()
    if (looksLikeTz(data?.timezone)) {
      cache.set(slackUserId, { tz: data.timezone, at: Date.now() })
      return data.timezone
    }
  } catch {
    /* fall through to studio default */
  }

  return checkinTimezone()
}
