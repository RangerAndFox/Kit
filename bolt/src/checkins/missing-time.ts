// @ts-nocheck
/**
 * Missing-time monitor (Feature #10 extension).
 *
 * A daily scan over each in-house creative's Harvest activity. If someone has
 * gone N consecutive *working* days (default 3) with zero logged hours — and
 * didn't explicitly mark those days "skip"/PTO via a check-in — Kit flags it to
 * the producers' channel. Harvest is the source of truth: logging directly in
 * Harvest (without ever replying to Kit) counts, so we never nag someone who's
 * actually tracking their time.
 *
 * Idempotent: alerts once per streak (keyed on the streak's start date), then
 * stays quiet until the artist logs again and a fresh gap opens.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { listTimeEntriesForUser } from '../../../src/lib/harvest/client'
import {
  checkinToday,
  checkinTimezone,
  ymdAddDays,
  isWorkday,
  formatShortDate,
} from './date'
import { inferActiveProjectChannels, type ActiveChannel } from './slack-activity'

const DEFAULT_THRESHOLD = 3
const LOOKBACK_DAYS = 21

export function missingThresholdDays(): number {
  const n = parseInt(process.env.HOURS_MISSING_THRESHOLD_DAYS || '', 10)
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_THRESHOLD
}

interface StaffRow {
  id: string
  slack_user_id: string
  full_name: string | null
  harvest_user_id: number | null
}

/**
 * The trailing run of working days with no logged time, ending at `through`
 * (the most recent completed day — yesterday). Walks most-recent-first and
 * stops at the first working day that has logged time OR was explicitly
 * skipped. Returns the missing days in descending order (newest first).
 */
export function computeMissingStreak(opts: {
  through: string
  loggedDates: Set<string>
  skippedDates: Set<string>
  tz?: string
  lookbackDays?: number
}): string[] {
  const tz = opts.tz || checkinTimezone()
  const lookback = opts.lookbackDays ?? LOOKBACK_DAYS
  const missing: string[] = []
  let cursor = opts.through
  for (let i = 0; i < lookback; i++, cursor = ymdAddDays(cursor, -1)) {
    if (!isWorkday(cursor, tz)) continue
    if (opts.loggedDates.has(cursor) || opts.skippedDates.has(cursor)) break
    missing.push(cursor)
  }
  return missing
}

/**
 * Evaluate one staff member. Returns the streak info if they're newly over the
 * threshold and haven't been alerted for this streak yet; null otherwise.
 */
async function evaluateStaff(staff: StaffRow): Promise<{
  missing: string[]
  lastLogged: string | null
} | null> {
  if (!staff.harvest_user_id) return null
  const tz = checkinTimezone()
  const through = ymdAddDays(checkinToday(new Date(), tz), -1) // yesterday
  const from = ymdAddDays(through, -(LOOKBACK_DAYS - 1))

  let loggedDates = new Set<string>()
  let lastLogged: string | null = null
  try {
    const entries = await listTimeEntriesForUser({
      userId: staff.harvest_user_id,
      from,
      to: through,
    })
    for (const e of entries) {
      if (e.hours > 0) {
        loggedDates.add(e.spent_date)
        if (!lastLogged || e.spent_date > lastLogged) lastLogged = e.spent_date
      }
    }
  } catch (err: any) {
    console.warn(`[missing-time] Harvest fetch failed for ${staff.slack_user_id}: ${err.message}`)
    return null // can't judge without data — don't false-flag
  }

  // Days the artist explicitly said they didn't work — not "missing".
  const sb = createAdminClient()
  const skippedDates = new Set<string>()
  const { data: skips } = await sb
    .from('daily_hours_checkins')
    .select('check_in_date')
    .eq('staff_id', staff.id)
    .eq('status', 'skipped')
    .gte('check_in_date', from)
    .lte('check_in_date', through)
  for (const r of skips || []) skippedDates.add(r.check_in_date)

  const missing = computeMissingStreak({ through, loggedDates, skippedDates, tz })
  if (missing.length < missingThresholdDays()) return null
  return { missing, lastLogged }
}

/**
 * Scan all in-house creatives and flag anyone newly over the missing-time
 * threshold. Posts to HOURS_ALERT_CHANNEL_ID (silent if unset).
 */
export async function scanMissingTime(app: App): Promise<{
  scanned: number
  flagged: number
  skippedAlready: number
}> {
  const channel = process.env.HOURS_ALERT_CHANNEL_ID
  if (!channel) {
    console.log('[missing-time] HOURS_ALERT_CHANNEL_ID unset — scan skipped.')
    return { scanned: 0, flagged: 0, skippedAlready: 0 }
  }

  const sb = createAdminClient()
  const { data: staff, error } = await sb
    .from('staff')
    .select('id, slack_user_id, full_name, harvest_user_id')
    .eq('role', 'creative')
    .eq('employment_type', 'employee')
    .eq('is_active', true)
  if (error) throw new Error(`load staff failed: ${error.message}`)

  const tally = { scanned: 0, flagged: 0, skippedAlready: 0 }
  for (const s of staff || []) {
    tally.scanned++
    const result = await evaluateStaff(s as StaffRow)
    if (!result) continue

    const streakStart = result.missing[result.missing.length - 1] // earliest

    // Idempotency: only alert once per streak. Insert first; a duplicate-key
    // collision means we already flagged this streak.
    const { error: insErr } = await sb.from('hours_missing_alerts').insert({
      staff_id: s.id,
      slack_user_id: s.slack_user_id,
      streak_start_date: streakStart,
      streak_days: result.missing.length,
      missing_dates: result.missing,
      last_logged_date: result.lastLogged,
      alert_channel_id: channel,
    })
    if (insErr) {
      // Unique violation (23505) → already alerted this streak.
      if ((insErr as any).code === '23505') tally.skippedAlready++
      else console.warn(`[missing-time] alert insert failed for ${s.slack_user_id}: ${insErr.message}`)
      continue
    }

    // Best-effort: where has this artist been active lately?
    const activeChannels = await inferActiveProjectChannels({
      app,
      slackUserId: s.slack_user_id,
    })

    try {
      const post = await app.client.chat.postMessage({
        channel,
        text: buildFlagText({
          slackUserId: s.slack_user_id,
          fullName: s.full_name,
          missing: result.missing,
          lastLogged: result.lastLogged,
          activeChannels,
        }),
      })
      // Backfill the message ts for traceability.
      if (post.ts) {
        await sb
          .from('hours_missing_alerts')
          .update({ alert_ts: post.ts })
          .eq('staff_id', s.id)
          .eq('streak_start_date', streakStart)
      }
      tally.flagged++
    } catch (err: any) {
      console.warn(`[missing-time] flag post failed for ${s.slack_user_id}: ${err.message}`)
    }
  }

  console.log(
    `[missing-time] scan done — scanned=${tally.scanned} flagged=${tally.flagged} alreadyFlagged=${tally.skippedAlready}`,
  )
  return tally
}

/** Producer-facing flag message. */
export function buildFlagText(opts: {
  slackUserId: string
  fullName: string | null
  missing: string[]
  lastLogged: string | null
  activeChannels?: ActiveChannel[]
}): string {
  const who = opts.slackUserId ? `<@${opts.slackUserId}>` : opts.fullName || 'A creative'
  const days = opts.missing.length
  const ordered = [...opts.missing].reverse() // earliest → latest
  const range =
    ordered.length === 1
      ? formatShortDate(ordered[0])
      : `${formatShortDate(ordered[0])} – ${formatShortDate(ordered[ordered.length - 1])}`
  const last = opts.lastLogged
    ? `Last logged: ${formatShortDate(opts.lastLogged)}.`
    : 'No logged time in the last few weeks.'
  const lines = [
    `:rotating_light: *Missing time* — ${who} has logged no hours in Harvest for ` +
      `*${days} working days* (${range}). ${last}`,
  ]
  const active = (opts.activeChannels || []).slice(0, 5)
  if (active.length) {
    lines.push(`Active lately in: ${active.map((a) => `<#${a.channelId}>`).join(' ')}`)
  }
  lines.push('_Worth a nudge or a quick check-in._')
  return lines.join('\n')
}
