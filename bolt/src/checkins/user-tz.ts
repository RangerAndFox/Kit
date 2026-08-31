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

// The check-in cron ticks HOURLY and only acts on the 17:00-local boundary, so
// the timezone used for that decision must reflect the person's CURRENT Slack
// profile — not a value cached up to 12h earlier. A 12h TTL let a single bad or
// transient users.info read (e.g. a mobile client momentarily reporting a
// travel timezone) mistime a whole day's check-in: the DM fired at the wrong
// local hour and the person never completed it. Keeping the TTL under the cron
// interval means every hourly tick re-resolves fresh, bounding the blast radius
// of any one bad read to that tick. users.info is a high-tier Slack endpoint and
// the check-in roster is small, so per-tick resolution is well within limits.
const TTL_MS = 50 * 60 * 1000
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
  // Last value we resolved (possibly expired) — used only to surface flips.
  const prevTz = hit?.tz

  // Fresh from Slack — and persist for the src/lib side.
  try {
    const res = await app.client.users.info({ user: slackUserId })
    const tz = (res.user as any)?.tz
    if (looksLikeTz(tz)) {
      // A changed timezone is the exact signal that mistimes a check-in — make
      // it visible so a recurring flip (travel, a stale client, a bad read) is
      // diagnosable from the logs instead of only from the send-time forensics.
      if (prevTz && prevTz !== tz) {
        console.log(`[user-tz] ${slackUserId} timezone changed ${prevTz} → ${tz}`)
      }
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

  // No fresh Slack tz and no usable last-known value: this person has no
  // resolvable timezone, so their check-in fires on the studio default and may
  // be mistimed. Surface it — it's a real misconfiguration, not a quiet default.
  console.warn(
    `[user-tz] no resolvable timezone for ${slackUserId}; using studio default ${checkinTimezone()}`,
  )
  return checkinTimezone()
}
