// @ts-nocheck
/**
 * Daily Hours Check-in — Confirm & Log to Harvest
 *
 * Wired from handlers/interactions.ts:
 *   - checkin_confirm → write each parsed entry to Harvest via createTimeEntry
 *   - checkin_redo    → reset the check-in to status='sent' so the user can reply again
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import {
  createTimeEntry,
  getDefaultTask,
  type HarvestTimeEntry,
} from '../../../src/lib/harvest/client'

interface CheckinRow {
  id: string
  staff_id: string
  slack_user_id: string
  check_in_date: string
  status: string
  dm_channel_id: string | null
  dm_ts: string | null
  parsed_entries: any
}

interface StaffRow {
  id: string
  harvest_user_id: number | null
  full_name: string | null
}

async function loadCheckin(checkinId: string): Promise<CheckinRow | null> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('daily_hours_checkins')
    .select(
      'id, staff_id, slack_user_id, check_in_date, status, dm_channel_id, dm_ts, parsed_entries',
    )
    .eq('id', checkinId)
    .maybeSingle()
  if (error) {
    console.warn(`[checkin-confirm] load failed: ${error.message}`)
    return null
  }
  return (data as CheckinRow) || null
}

async function loadStaff(staffId: string): Promise<StaffRow | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('staff')
    .select('id, harvest_user_id, full_name')
    .eq('id', staffId)
    .maybeSingle()
  return (data as StaffRow) || null
}

/**
 * Post the result message flat in the DM — check-in messages never thread.
 * People reply in the main chat, so a threaded result hides behind a
 * "1 reply" link they'll never open (operator-reported).
 */
async function postResult(opts: {
  app: App
  channelId: string
  threadTs: string | null
  text: string
}) {
  const { app, channelId, text } = opts
  await app.client.chat.postMessage({
    channel: channelId,
    text,
  })
}

export async function handleCheckinConfirm(opts: {
  app: App
  client: any
  body: any
  checkinId: string
}): Promise<void> {
  const { app, checkinId } = opts
  const checkin = await loadCheckin(checkinId)
  if (!checkin) return

  const entries = Array.isArray(checkin.parsed_entries) ? checkin.parsed_entries : []
  if (entries.length === 0) return

  const sb = createAdminClient()

  // Claim the row (compare-and-set) BEFORE writing to Harvest. A plain
  // status check is a TOCTOU: two quick clicks (or a Slack action retry)
  // both pass it and every entry gets logged twice. Losing the claim means
  // another click is already mid-flight — bail silently. A claim ERROR is
  // different and must be loud: a status-constraint mismatch silently
  // killed every confirm for days.
  const { data: claimed, error: claimError } = await sb
    .from('daily_hours_checkins')
    .update({ status: 'logging', updated_at: new Date().toISOString() })
    .eq('id', checkin.id)
    .eq('status', 'parsed')
    .select('id')
  if (claimError) {
    console.error(`[checkin-confirm] claim write failed: ${claimError.message}`)
    await postResult({
      app,
      channelId: checkin.dm_channel_id || '',
      threadTs: checkin.dm_ts,
      text: `:warning: Couldn't start logging (internal error: ${claimError.message}). Ping an admin.`,
    })
    return
  }
  if (!claimed || claimed.length === 0) return

  const staff = await loadStaff(checkin.staff_id)
  if (!staff?.harvest_user_id) {
    // Release the claim so a fixed mapping can be confirmed later.
    await sb
      .from('daily_hours_checkins')
      .update({ status: 'parsed', updated_at: new Date().toISOString() })
      .eq('id', checkin.id)
      .eq('status', 'logging')
    await postResult({
      app,
      channelId: checkin.dm_channel_id || '',
      threadTs: checkin.dm_ts,
      text: ":warning: I don't have a Harvest user mapping for you — ask an admin to run the staff sync.",
    })
    return
  }
  const logged: HarvestTimeEntry[] = []
  const failures: string[] = []

  for (const entry of entries) {
    if (entry.resolution !== 'matched' || !entry.harvest_project_id) {
      failures.push(`${entry.hours}h "${entry.projectQuery}" (unmatched)`)
      continue
    }
    try {
      const task = await getDefaultTask(entry.harvest_project_id)
      if (!task) {
        failures.push(`${entry.hours}h ${entry.harvest_project_name} (no task)`)
        continue
      }
      const te = await createTimeEntry({
        projectId: entry.harvest_project_id,
        taskId: task.id,
        hours: entry.hours,
        // Per-entry day ("yesterday" etc.), falling back to the check-in day.
        spentDate: entry.spentDate || checkin.check_in_date,
        notes: entry.notes || undefined,
        userId: staff.harvest_user_id,
      })
      logged.push(te)
    } catch (err: any) {
      console.warn(
        `[checkin-confirm] createTimeEntry failed for project ${entry.harvest_project_id}: ${err.message}`,
      )
      failures.push(`${entry.hours}h ${entry.harvest_project_name} (${err.message})`)
    }
  }

  // Update row
  await sb
    .from('daily_hours_checkins')
    .update({
      status: failures.length === 0 ? 'logged' : 'failed',
      logged_at: new Date().toISOString(),
      error_message: failures.length ? failures.join('; ') : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', checkin.id)

  // Reply with the result
  const summary = logged
    .map((e) => `• *${e.hours}h* — ${e.project.name} (${e.task.name})`)
    .join('\n')
  let text: string
  if (failures.length === 0) {
    text = `:white_check_mark: Logged to Harvest:\n${summary}`
  } else if (logged.length === 0) {
    text = `:x: Couldn't log any entries:\n• ${failures.join('\n• ')}`
  } else {
    text = `:large_yellow_circle: Partially logged.\n*Logged:*\n${summary}\n\n*Skipped:*\n• ${failures.join('\n• ')}`
  }
  await postResult({
    app,
    channelId: checkin.dm_channel_id || '',
    threadTs: checkin.dm_ts,
    text,
  })
}

export async function handleCheckinRedo(opts: {
  app: App
  client: any
  body: any
  checkinId: string
}): Promise<void> {
  const { app, checkinId } = opts
  const checkin = await loadCheckin(checkinId)
  if (!checkin) return

  const sb = createAdminClient()
  await sb
    .from('daily_hours_checkins')
    .update({
      status: 'sent',
      parsed_entries: null,
      reply_ts: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', checkin.id)

  await postResult({
    app,
    channelId: checkin.dm_channel_id || '',
    threadTs: checkin.dm_ts,
    text: ":arrows_counterclockwise: Cleared — go ahead and resend your hours.",
  })
}
