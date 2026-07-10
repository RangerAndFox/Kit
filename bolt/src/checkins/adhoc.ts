// @ts-nocheck
/**
 * Ad-hoc Hours Entry
 *
 * Fires when a creative messages Kit unprompted with hours intent
 * (e.g. "log 2h on Rayfin" or "spent 3 hours on IQ Sizzle yesterday").
 *
 * Uses the same parse → resolve → confirmation pipeline as the scheduled
 * daily check-in, but creates a fresh check-in row with origin='adhoc'
 * so the existing Confirm/Redo button handlers work unchanged.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import {
  parseReplyWithLLM,
  resolveHarvestProject,
  buildConfirmBlocks,
  type ParsedEntry,
} from './reply'
import { checkinToday, resolveSpentDate, resolveDayPhrase } from './date'

/**
 * Cheap pre-filter: does the message even mention hours? Avoids burning
 * an LLM call on every DM. Matches "4h", "2.5 hrs", "3 hours", "half hour".
 */
const HOURS_RE =
  /\b(?:\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours)|half\s*(?:an?\s+)?(?:hour|hr)|quarter\s*(?:of\s+an?\s+)?(?:hour|hr))\b/i

export function looksLikeHoursIntent(text: string): boolean {
  return HOURS_RE.test(text)
}

interface StaffRow {
  id: string
  slack_user_id: string
  harvest_user_id: number | null
  employment_type: string | null
}

async function loadStaffBySlackId(slackUserId: string): Promise<StaffRow | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('staff')
    .select('id, slack_user_id, harvest_user_id, employment_type')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()
  return (data as StaffRow) || null
}

/**
 * Handle an unprompted hours message. Returns true if handled.
 */
export async function handleAdhocHoursEntry(opts: {
  app: App
  slackUserId: string
  channelId: string
  messageText: string
  messageTs: string
  threadTs?: string
}): Promise<boolean> {
  const { app, slackUserId, channelId, messageText, messageTs, threadTs } = opts

  // 1. Staff lookup — required for harvest_user_id attribution
  const staff = await loadStaffBySlackId(slackUserId)
  if (!staff) {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text:
        ":wave: I don't have you in the staff directory yet — ask an admin to run the staff sync and set your role.",
    })
    return true
  }
  if (!staff.harvest_user_id) {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text:
        ":warning: You're in the directory but not mapped to a Harvest user. Ask an admin to check your email matches Harvest.",
    })
    return true
  }
  if (staff.employment_type !== 'employee') {
    // Hours-via-Kit is employee-only. Freelancers/contractors log in
    // Harvest directly. Falling through to the orchestrator would be
    // confusing here, so we acknowledge and stop.
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text:
        ":lock: Hours logging through Kit is only enabled for in-house employees right now. Log freelance hours directly in Harvest.",
    })
    return true
  }

  // 2. Parse with the LLM
  const today = checkinToday()
  let parsed: { entries: any[]; skip: boolean }
  try {
    parsed = await parseReplyWithLLM({
      replyText: messageText,
      candidateProjects: [],
      today,
    })
  } catch (err: any) {
    console.warn(`[adhoc-hours] parse failed: ${err.message}`)
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ":thinking_face: I couldn't parse that. Try _'4h on Rayfin'_.",
    })
    return true
  }

  if (parsed.skip || parsed.entries.length === 0) {
    // Not actually a time entry; let the orchestrator handle it instead
    // by returning false. The pre-filter regex was a false positive.
    return false
  }

  // 3. Resolve each project against Harvest
  const resolved: ParsedEntry[] = await Promise.all(
    parsed.entries.map(async (e: any) => {
      const r = await resolveHarvestProject(e.projectQuery)
      return {
        projectQuery: e.projectQuery,
        hours: Number(e.hours),
        notes: e.notes || undefined,
        spentDate: resolveSpentDate(resolveDayPhrase(e.date, today), today),
        resolution: r.resolution,
        harvest_project_id: r.project?.id,
        harvest_project_name: r.project?.name,
        candidates:
          r.candidates?.map((c) => ({ id: c.id, name: c.name })) || undefined,
      }
    }),
  )

  // 4. Create an ad-hoc check-in row to track this confirmation
  const sb = createAdminClient()
  const { data: row, error } = await sb
    .from('daily_hours_checkins')
    .insert({
      staff_id: staff.id,
      slack_user_id: slackUserId,
      check_in_date: today,
      status: 'parsed',
      origin: 'adhoc',
      candidate_projects: [],
      parsed_entries: resolved,
      dm_channel_id: channelId,
      dm_ts: messageTs,
      reply_ts: messageTs,
    })
    .select('id')
    .single()
  if (error || !row) {
    console.warn(`[adhoc-hours] insert failed: ${error?.message}`)
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ":warning: Something went wrong saving your entry. Try again in a moment.",
    })
    return true
  }

  // 5. Post the confirmation card
  await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: 'Confirm hours',
    blocks: buildConfirmBlocks({ checkinId: row.id, entries: resolved, anchorDate: today }),
  })

  return true
}
