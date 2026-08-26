// @ts-nocheck
/**
 * Daily Hours Check-in — shared helpers.
 *
 * The CANONICAL scheduled sender is now reminder-delivery.ts (durable occurrence
 * + effectively-once delivery to Kit's direct-message conversation). This file
 * keeps the shared, pure pieces it reuses — the message body (composeDm), the
 * local-hour resolver (localHourAt), and candidate merging — plus the
 * (currently dormant) evening nudge. No suggested-projects list (operator
 * direction): replies are free-form and the resolver fuzzy-matches project
 * code, client name, or keywords.
 *
 * The reply is handled separately in handlers/messages.ts (intercepts a reply
 * from staff with an open check-in row, in a DM or a legacy personal Kit channel).
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { CHECKIN_STALE_AFTER_DAYS, checkinToday, ymdAddDays } from './date'
import type { ActiveChannel } from './slack-activity'

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
 * Compose the reminder body. Uses Slack mrkdwn (single-asterisk bold).
 * Deliberately no suggested-projects list (operator direction): just ask.
 * Project names in replies are fuzzy-matched — code, client, or keywords
 * all resolve. Exported: the canonical sender (reminder-delivery.ts) reuses it.
 */
export function composeDm(opts: { firstName: string }): string {
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
 * Local hour (0-23) at an instant in the given timezone. Computed per call via
 * Intl so DST is always right. Shared by the durable scheduler and tests.
 */
export function localHourAt(now: Date, tz: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(
      now,
    ),
  )
}

/**
 * Send a single nudge for each unfinished check-in: no reply yet
 * (status='sent'), or a confirmation card never clicked (status='parsed').
 *
 * This function existed but was never scheduled, so NOTHING chased an
 * unconfirmed card — hours people had already reported sat parsed-but-unlogged
 * indefinitely (72h across the team when this was found), and the missing-time
 * monitor never surfaced them because it only reports 3+ CONSECUTIVE missing
 * days and these were scattered singles. It now runs each morning (never after
 * hours, per operator direction).
 *
 * Scans back over the staleness window rather than today only: a card that goes
 * unclicked is exactly the case that needs following up, and it is worth
 * nothing if the reminder only ever fires on the day it was posted. Still at
 * most one nudge per check-in (nudged_at), so re-running is safe.
 */
export async function nudgePendingCheckins(app: App): Promise<{ nudged: number }> {
  const sb = createAdminClient()
  const today = checkinToday()
  const { data: rows, error } = await sb
    .from('daily_hours_checkins')
    .select('id, slack_user_id, dm_channel_id, dm_ts, status, check_in_date, nudged_at, parsed_entries')
    .gte('check_in_date', ymdAddDays(today, -CHECKIN_STALE_AFTER_DAYS))
    .in('status', ['sent', 'parsed'])
  if (error) throw new Error(`load pending failed: ${error.message}`)

  let nudged = 0
  for (const r of rows || []) {
    if (!r.dm_channel_id) continue
    const entries = Array.isArray(r.parsed_entries) ? r.parsed_entries : []
    // Zero-hour cards are closed by the health reconciliation and do not need
    // reminders. For parsed positive-hour cards, remind every other morning
    // until confirmed; unanswered initial prompts still receive only one nudge.
    if (r.status === 'parsed' && !entries.some((e: any) => Number(e?.hours) > 0)) continue
    if (r.status === 'sent' && r.nudged_at) continue
    if (r.status === 'parsed' && r.nudged_at) {
      const ageMs = Date.now() - new Date(r.nudged_at).getTime()
      if (Number.isFinite(ageMs) && ageMs < 48 * 60 * 60 * 1000) continue
    }
    try {
      // Name the day: with the window reaching back, "today's hours" would be
      // wrong for anything the reminder catches up on.
      const when = r.check_in_date === today ? 'today' : `*${r.check_in_date}*`
      const text =
        r.status === 'parsed'
          ? `:wave: Friendly nudge — your hours for ${when} are parsed but still waiting on the *Confirm & log* button above.`
          : `:wave: Friendly nudge — got a sec to log your hours for ${when}? Just reply with what you worked on.`
      await app.client.chat.postMessage({
        channel: r.dm_channel_id,
        text,
      })
      // Keep 'parsed' status (the card is still actionable) and refresh the
      // nudge timestamp so it is eligible again after the two-day cooldown.
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
