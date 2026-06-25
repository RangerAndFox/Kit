// @ts-nocheck
/**
 * Daily Hours Check-in
 *
 * Phase 1: Harvest-only signal.
 *
 * For each active creative in public.staff:
 *   1. Pull their Harvest time entries from the last 7 days.
 *   2. Rank projects by total hours logged (frequency × intensity).
 *   3. DM them with the top candidates + an open question for hours.
 *   4. Insert a daily_hours_checkins row tracking the conversation.
 *
 * The reply is handled separately in handlers/messages.ts (intercepts
 * DMs from staff with an open check-in row).
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import {
  listTimeEntriesForUser,
  type HarvestTimeEntry,
} from '../../../src/lib/harvest/client'
import { checkinToday, checkinDateMinusDays } from './date'
import { inferActiveProjectChannels, type ActiveChannel } from './slack-activity'

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
 * Build per-user candidate projects from Harvest time entries in the last
 * 7 days. Higher recent hours → higher rank. Returns top 5.
 */
function rankCandidatesFromHarvest(entries: HarvestTimeEntry[]): CandidateProject[] {
  const byProject = new Map<number, { name: string; hours: number }>()
  for (const e of entries) {
    const cur = byProject.get(e.project.id) || { name: e.project.name, hours: 0 }
    cur.hours += e.hours
    byProject.set(e.project.id, cur)
  }
  return [...byProject.entries()]
    .map(([id, v]) => ({
      harvest_project_id: id,
      harvest_project_name: v.name,
      signal_hours_last_7d: Math.round(v.hours * 10) / 10,
      reasons: ['Harvest (last 7d)'],
    }))
    .sort((a, b) => b.signal_hours_last_7d - a.signal_hours_last_7d)
    .slice(0, 5)
}

/**
 * Compose the DM body. Uses Slack mrkdwn (single-asterisk bold).
 */
function composeDm(opts: {
  firstName: string
  candidates: CandidateProject[]
}): string {
  const { firstName, candidates } = opts
  const intro = `:hourglass_flowing_sand: *Hours check-in for today*\n\nHey ${firstName} — quick log so we keep Harvest tidy.`
  if (candidates.length === 0) {
    return `${intro}\n\nI don't see any recent projects you've billed to. Reply with what you worked on today and how many hours, e.g. _"4h on Project Rayfin, 2h on IQ Sizzle"_.`
  }
  const lines = candidates.map((c, i) => {
    const detail =
      c.signal_hours_last_7d > 0
        ? `${c.signal_hours_last_7d}h last 7 days`
        : c.slack_channel_name
          ? `active in #${c.slack_channel_name}`
          : c.reasons[0] || 'recent activity'
    return `  ${i + 1}. *${c.harvest_project_name}* — ${detail}`
  })
  return [
    intro,
    '',
    'Based on your recent activity, your usual lately:',
    ...lines,
    '',
    'Reply with hours per project — natural language is fine. e.g.:',
    '> _4h on Rayfin, 2.5h on IQ Sizzle, 1h internal_',
    '',
    'Or `skip` if you didn\'t work today.',
  ].join('\n')
}

/**
 * Send the daily check-in DM to one staff member. No-ops if a check-in
 * already exists for today.
 */
export async function sendDailyCheckin(opts: {
  app: App
  staff: StaffRow
}): Promise<{ status: 'sent' | 'skipped' | 'duplicate' | 'failed'; reason?: string }> {
  const { app, staff } = opts
  const today = checkinToday()
  const sb = createAdminClient()

  // Duplicate guard: skip if a *scheduled* row already exists for today,
  // or if the user already logged today via ad-hoc.
  const { data: existing } = await sb
    .from('daily_hours_checkins')
    .select('id, status, origin')
    .eq('staff_id', staff.id)
    .eq('check_in_date', today)
  const blocked = (existing || []).some(
    (r: any) => r.origin === 'scheduled' || r.status === 'logged',
  )
  if (blocked) return { status: 'duplicate' }

  if (!staff.harvest_user_id) {
    return { status: 'skipped', reason: 'no harvest_user_id mapping' }
  }

  // Pull last 7 days of Harvest entries.
  const to = today
  const from = checkinDateMinusDays(7)

  let candidates: CandidateProject[] = []
  try {
    const entries = await listTimeEntriesForUser({
      userId: staff.harvest_user_id,
      from,
      to,
    })
    candidates = rankCandidatesFromHarvest(entries)
  } catch (err: any) {
    console.warn(
      `[daily-hours] Harvest fetch failed for ${staff.slack_user_id} (${staff.email}): ${err.message}`,
    )
    // Continue with empty candidates — user can still reply free-form.
  }

  // Enrich with live project channels the artist is active in but may not have
  // billed to yet (best-effort; never blocks the check-in).
  const active = await inferActiveProjectChannels({ app, slackUserId: staff.slack_user_id })
  candidates = mergeCandidates(candidates, active)

  // Open a DM channel and post the message.
  let dmChannelId: string
  let dmTs: string
  try {
    const open = await app.client.conversations.open({ users: staff.slack_user_id })
    dmChannelId = open.channel?.id || ''
    if (!dmChannelId) throw new Error('conversations.open returned no channel id')

    const firstName = (staff.full_name || '').split(/\s+/)[0] || 'there'
    const text = composeDm({ firstName, candidates })
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
    candidate_projects: candidates,
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
 * Send all daily check-ins. Called by the cron at 5pm local.
 * Returns a per-user summary for logging.
 */
export async function sendAllDailyCheckins(app: App): Promise<{
  sent: number
  duplicate: number
  skipped: number
  failed: number
}> {
  const sb = createAdminClient()
  const { data: staff, error } = await sb
    .from('staff')
    .select('id, slack_user_id, email, full_name, harvest_user_id')
    .eq('role', 'creative')
    .eq('employment_type', 'employee')
    .eq('is_active', true)
  if (error) throw new Error(`load staff failed: ${error.message}`)

  const tally = { sent: 0, duplicate: 0, skipped: 0, failed: 0 }
  for (const s of staff || []) {
    const r = await sendDailyCheckin({ app, staff: s as StaffRow })
    tally[r.status === 'duplicate' ? 'duplicate' : r.status] += 1
    if (r.status === 'failed') {
      console.warn(`[daily-hours] ${s.slack_user_id} failed: ${r.reason}`)
    }
  }
  console.log(
    `[daily-hours] cycle done — sent=${tally.sent} duplicate=${tally.duplicate} skipped=${tally.skipped} failed=${tally.failed}`,
  )
  return tally
}

/**
 * Send a single nudge to anyone with status='sent' from today and no reply.
 * Marks status='nudged'. Called by the cron at 10pm local.
 */
export async function nudgePendingCheckins(app: App): Promise<{ nudged: number }> {
  const sb = createAdminClient()
  const today = checkinToday()
  const { data: rows, error } = await sb
    .from('daily_hours_checkins')
    .select('id, slack_user_id, dm_channel_id, dm_ts')
    .eq('check_in_date', today)
    .eq('status', 'sent')
    .is('nudged_at', null)
  if (error) throw new Error(`load pending failed: ${error.message}`)

  let nudged = 0
  for (const r of rows || []) {
    if (!r.dm_channel_id) continue
    try {
      await app.client.chat.postMessage({
        channel: r.dm_channel_id,
        thread_ts: r.dm_ts || undefined,
        text: ":wave: Friendly nudge — got a sec to log today's hours? Just reply with what you worked on.",
      })
      await sb
        .from('daily_hours_checkins')
        .update({ status: 'nudged', nudged_at: new Date().toISOString() })
        .eq('id', r.id)
      nudged++
    } catch (err: any) {
      console.warn(`[daily-hours] nudge failed for ${r.slack_user_id}: ${err.message}`)
    }
  }
  console.log(`[daily-hours] nudge cycle done — nudged=${nudged}`)
  return { nudged }
}
