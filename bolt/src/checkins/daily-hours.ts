// @ts-nocheck
/**
 * Daily Hours Check-in
 *
 * For each staff member with the daily_checkin flag: DM an open question
 * for today's hours and insert a daily_hours_checkins row tracking the
 * conversation. No suggested-projects list (operator direction) — replies
 * are free-form and the resolver fuzzy-matches project code, client name,
 * or keywords.
 *
 * The reply is handled separately in handlers/messages.ts (intercepts
 * DMs from staff with an open check-in row).
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { checkinToday, checkinTimezone, isWorkday } from './date'
import { resolveUserTimezone } from './user-tz'
import type { ActiveChannel } from './slack-activity'

interface StaffRow {
  id: string
  slack_user_id: string
  email: string | null
  full_name: string | null
  harvest_user_id: number | null
}

interface CandidateProject {
  harvest_project_id?: number
  harvest_project_name: string
  signal_hours_last_7d: number
  reasons: string[]
  slack_channel_id?: string
  slack_channel_name?: string
}

/**
 * Merge Harvest-derived candidates with Slack-activity ones. Harvest entries
 * (real logged hours) rank first; inferred project channels the artist is in
 * but hasn't billed to are appended, deduped by project name. Capped at `max`.
 */
export function mergeCandidates(
  harvest: CandidateProject[],
  active: ActiveChannel[],
  max = 6,
): CandidateProject[] {
  const seen = new Set(harvest.map((c) => c.harvest_project_name.trim().toLowerCase()))
  const merged = [...harvest]
  for (const a of active) {
    const key = a.projectName.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({
      harvest_project_name: a.projectName,
      signal_hours_last_7d: 0,
      reasons: [`Active in #${a.channelName}`],
      slack_channel_id: a.channelId,
      slack_channel_name: a.channelName,
    })
  }
  return merged.slice(0, max)
}

/**
 * Compose the DM body. Uses Slack mrkdwn (single-asterisk bold).
 * Deliberately no suggested-projects list (operator direction): just ask.
 * Project names in replies are fuzzy-matched — code, client, or keywords
 * all resolve.
 */
function composeDm(opts: { firstName: string }): string {
  return [
    `:hourglass_flowing_sand: *Hours check-in for today*`,
    '',
    `Hey ${opts.firstName} — quick log so we keep Harvest tidy.`,
    '',
    'Reply with hours per project — natural language is fine, and project codes, client names, or keywords all work. e.g.:',
    '> _4h on Rayfin, 2h on 2611, 30 min on the crunchyroll expo_',
    '',
    "Or `skip` if you didn't work today.",
  ].join('\n')
}

/**
 * True when it's currently the check-in hour (5pm by default) in the given
 * timezone. Computed per call via Intl so DST is always right. Pure — tested.
 */
export function isLocalCheckinHour(
  now: Date,
  tz: string,
  hour = 17,
): boolean {
  const localHour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(
      now,
    ),
  )
  return localHour === hour
}

/**
 * Send the daily check-in DM to one staff member. No-ops if a check-in
 * already exists for today (their local today).
 */
export async function sendDailyCheckin(opts: {
  app: App
  staff: StaffRow
  /** The recipient's timezone — anchors check_in_date to THEIR calendar day. */
  tz?: string
}): Promise<{ status: 'sent' | 'skipped' | 'duplicate' | 'failed'; reason?: string }> {
  const { app, staff } = opts
  const today = checkinToday(new Date(), opts.tz || checkinTimezone())
  const sb = createAdminClient()

  // Duplicate guard: skip if a scheduled row already exists for today, the
  // user already logged via ad-hoc, OR any row for today is still OPEN
  // (sent/nudged/parsed/logging — e.g. an ad-hoc redo). Two open rows would
  // make every reply ambiguous about which check-in it answers.
  const { data: existing } = await sb
    .from('daily_hours_checkins')
    .select('id, status, origin')
    .eq('staff_id', staff.id)
    .eq('check_in_date', today)
  const blocked = (existing || []).some(
    (r: any) =>
      r.origin === 'scheduled' ||
      ['logged', 'sent', 'nudged', 'replied', 'parsed', 'logging'].includes(r.status),
  )
  if (blocked) return { status: 'duplicate' }

  if (!staff.harvest_user_id) {
    return { status: 'skipped', reason: 'no harvest_user_id mapping' }
  }

  // Open a DM channel and post the message. (No suggested-projects list —
  // replies are free-form and the resolver fuzzy-matches code/client/name.)
  let dmChannelId: string
  let dmTs: string
  try {
    const open = await app.client.conversations.open({ users: staff.slack_user_id })
    dmChannelId = open.channel?.id || ''
    if (!dmChannelId) throw new Error('conversations.open returned no channel id')

    const firstName = (staff.full_name || '').split(/\s+/)[0] || 'there'
    const text = composeDm({ firstName })
    const post = await app.client.chat.postMessage({ channel: dmChannelId, text })
    dmTs = post.ts || ''
    if (!dmTs) throw new Error('chat.postMessage returned no ts')
  } catch (err: any) {
    return { status: 'failed', reason: err.message }
  }

  // Insert tracking row.
  const { error } = await sb.from('daily_hours_checkins').insert({
    staff_id: staff.id,
    slack_user_id: staff.slack_user_id,
    check_in_date: today,
    status: 'sent',
    origin: 'scheduled',
    candidate_projects: [],
    dm_channel_id: dmChannelId,
    dm_ts: dmTs,
  })
  if (error) {
    console.warn(`[daily-hours] insert failed for ${staff.slack_user_id}: ${error.message}`)
    return { status: 'failed', reason: `insert: ${error.message}` }
  }

  return { status: 'sent' }
}

/**
 * Send due daily check-ins. Called by an HOURLY cron: each person gets
 * their check-in at 5pm in THEIR timezone (Slack profile), and their
 * check_in_date / holiday calendar resolve on their local day. People for
 * whom it isn't 5pm right now are simply not due this cycle.
 */
export async function sendAllDailyCheckins(app: App): Promise<{
  sent: number
  duplicate: number
  skipped: number
  failed: number
  notDue: number
}> {
  const sb = createAdminClient()
  // Membership is the explicit daily_checkin flag (not role) — producers,
  // CDs, and admins can opt in alongside the in-house creatives.
  const { data: staff, error } = await sb
    .from('staff')
    .select('id, slack_user_id, email, full_name, harvest_user_id')
    .eq('daily_checkin', true)
    .eq('is_active', true)
  if (error) throw new Error(`load staff failed: ${error.message}`)

  const now = new Date()
  const tally = { sent: 0, duplicate: 0, skipped: 0, failed: 0, notDue: 0 }
  for (const s of staff || []) {
    const tz = await resolveUserTimezone({ app, slackUserId: s.slack_user_id })
    if (!isLocalCheckinHour(now, tz)) {
      tally.notDue += 1
      continue
    }
    // Weekend/holiday on THEIR calendar day — no check-in.
    if (!isWorkday(checkinToday(now, tz), tz)) {
      tally.skipped += 1
      continue
    }
    const r = await sendDailyCheckin({ app, staff: s as StaffRow, tz })
    tally[r.status === 'duplicate' ? 'duplicate' : r.status] += 1
    if (r.status === 'failed') {
      console.warn(`[daily-hours] ${s.slack_user_id} failed: ${r.reason}`)
    }
  }
  if (tally.sent || tally.failed || tally.duplicate) {
    console.log(
      `[daily-hours] cycle done — sent=${tally.sent} duplicate=${tally.duplicate} skipped=${tally.skipped} failed=${tally.failed} notDue=${tally.notDue}`,
    )
  }
  return tally
}

/**
 * Send a single nudge to anyone whose check-in from today is still
 * unfinished: no reply yet (status='sent'), or a confirmation card they
 * never clicked (status='parsed'). Called by the cron at 10pm local.
 */
export async function nudgePendingCheckins(app: App): Promise<{ nudged: number }> {
  const sb = createAdminClient()
  const today = checkinToday()
  const { data: rows, error } = await sb
    .from('daily_hours_checkins')
    .select('id, slack_user_id, dm_channel_id, dm_ts, status')
    .eq('check_in_date', today)
    .in('status', ['sent', 'parsed'])
    .is('nudged_at', null)
  if (error) throw new Error(`load pending failed: ${error.message}`)

  let nudged = 0
  for (const r of rows || []) {
    if (!r.dm_channel_id) continue
    try {
      const text =
        r.status === 'parsed'
          ? ':wave: Friendly nudge — your hours are parsed but waiting on the *Confirm & log* button above.'
          : ":wave: Friendly nudge — got a sec to log today's hours? Just reply with what you worked on."
      await app.client.chat.postMessage({
        channel: r.dm_channel_id,
        text,
      })
      // Keep 'parsed' status (the card is still actionable) — only mark the
      // nudge timestamp; 'sent' rows advance to 'nudged' as before.
      await sb
        .from('daily_hours_checkins')
        .update({
          ...(r.status === 'sent' ? { status: 'nudged' } : {}),
          nudged_at: new Date().toISOString(),
        })
        .eq('id', r.id)
      nudged++
    } catch (err: any) {
      console.warn(`[daily-hours] nudge failed for ${r.slack_user_id}: ${err.message}`)
    }
  }
  console.log(`[daily-hours] nudge cycle done — nudged=${nudged}`)
  return { nudged }
}
