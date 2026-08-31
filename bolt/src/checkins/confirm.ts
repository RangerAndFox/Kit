// @ts-nocheck
/**
 * Daily Hours Check-in — Confirm & Log to Harvest
 *
 * Wired from handlers/interactions.ts:
 *   - checkin_confirm → write each parsed entry to Harvest via createTimeEntry
 *   - checkin_redo    → reset the check-in to status='sent' so the user can reply again
 */

import type { App } from '@slack/bolt'
import { createHash } from 'node:crypto'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import {
  createTimeEntry,
  getDefaultTask,
  type HarvestTimeEntry,
} from '../../../src/lib/harvest/client'
import { CHECKIN_STALE_AFTER_DAYS, checkinToday, ymdDaysBetween } from './date'

interface CheckinRow {
  id: string
  staff_id: string
  slack_user_id: string
  check_in_date: string
  status: string
  dm_channel_id: string | null
  dm_ts: string | null
  parsed_entries: any
  harvest_entry_ids: any
  origin: string | null
}

interface StaffRow {
  id: string
  harvest_user_id: number | null
  full_name: string | null
}

/** Slack action values are row ids, never authorization. Only the owner of a
 * check-in may operate its card. Administrative repair uses the separate,
 * audited recovery tooling instead of impersonating a person's DM action. */
export function isCheckinActorAuthorized(
  checkinSlackUserId: string | null | undefined,
  actorSlackUserId: string | null | undefined,
): boolean {
  return Boolean(checkinSlackUserId && actorSlackUserId && checkinSlackUserId === actorSlackUserId)
}

async function loadCheckin(checkinId: string): Promise<CheckinRow | null> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('daily_hours_checkins')
    .select(
      'id, staff_id, slack_user_id, check_in_date, status, dm_channel_id, dm_ts, parsed_entries, harvest_entry_ids, origin',
    )
    .eq('id', checkinId)
    .maybeSingle()
  if (error) {
    console.warn(`[checkin-confirm] load failed: ${error.message}`)
    return null
  }
  return (data as CheckinRow) || null
}

/** Preserve earlier partial-success ids while appending a targeted retry. */
export function mergeHarvestEntryIds(existing: unknown, created: number[]): number[] {
  const before = Array.isArray(existing) ? existing.map(Number).filter(Number.isFinite) : []
  return [...new Set([...before, ...created])]
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
  actorSlackUserId: string
}): Promise<void> {
  const { app, checkinId } = opts
  const checkin = await loadCheckin(checkinId)
  if (!checkin) {
    console.warn(`[checkin-confirm] checkin ${checkinId} not found`)
    return
  }
  if (!isCheckinActorAuthorized(checkin.slack_user_id, opts.actorSlackUserId)) {
    console.warn(`[checkin-confirm] denied actor ${opts.actorSlackUserId || '(missing)'} for ${checkinId}`)
    return
  }
  console.log(`[checkin-confirm] confirming ${checkinId} (status=${checkin.status})`)

  const entries = Array.isArray(checkin.parsed_entries) ? checkin.parsed_entries : []
  if (entries.length === 0) return

  const sb = createAdminClient()

  // Confirmation cards never expired, so a months-old card kept a live button:
  // one stray click would write long-past hours to Harvest against a parse
  // nobody remembers approving. Past the staleness window, decline and say so.
  const ageDays = ymdDaysBetween(checkin.check_in_date, checkinToday())
  if (ageDays > CHECKIN_STALE_AFTER_DAYS) {
    console.log(`[checkin-confirm] ${checkin.id} is ${ageDays}d old — too stale to log`)
    await postResult({
      app,
      channelId: checkin.dm_channel_id || '',
      threadTs: checkin.dm_ts,
      text:
        `:hourglass: That check-in is from ${checkin.check_in_date} (${ageDays} days ago), so I'm not ` +
        `logging it automatically — please add those hours in Harvest directly.`,
    })
    return
  }

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
  const failedEntries: any[] = []

  for (const entry of entries) {
    if (entry.resolution !== 'matched' || !entry.harvest_project_id) {
      failures.push(`${entry.hours}h "${entry.projectQuery}" (unmatched)`)
      failedEntries.push(entry)
      continue
    }
    try {
      const task = await getDefaultTask(entry.harvest_project_id)
      if (!task) {
        failures.push(`${entry.hours}h ${entry.harvest_project_name} (no task)`)
        failedEntries.push(entry)
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
        idempotencyKey: `${checkin.id}:${createHash('sha256').update(JSON.stringify({
          project: entry.harvest_project_id,
          task: task.id,
          date: entry.spentDate || checkin.check_in_date,
          hours: entry.hours,
          notes: entry.notes || '',
        })).digest('hex').slice(0, 16)}`,
      })
      logged.push(te)
    } catch (err: any) {
      console.warn(
        `[checkin-confirm] createTimeEntry failed for project ${entry.harvest_project_id}: ${err.message}`,
      )
      failures.push(`${entry.hours}h ${entry.harvest_project_name} (${err.message})`)
      failedEntries.push(entry)
    }
  }

  const entryIds = logged.map((e) => e.id)
  const allEntryIds = mergeHarvestEntryIds(checkin.harvest_entry_ids, entryIds)
  console.log(
    `[checkin-confirm] ${checkin.id}: created ${logged.length} Harvest entr(ies) [${entryIds.join(', ')}], ${failures.length} failure(s)`,
  )

  // Update row — store the real Harvest entry ids so a "logged" status is
  // verifiable (and any hand-entered duplicate is traceable back to these).
  await sb
    .from('daily_hours_checkins')
    .update({
      status: failures.length === 0 ? 'logged' : 'failed',
      logged_at: new Date().toISOString(),
      harvest_entry_ids: allEntryIds.length ? allEntryIds : null,
      // A partial failure keeps only the still-unlogged lines. The successful
      // lines are represented by immutable Harvest ids and can never be
      // submitted again through the retry card.
      parsed_entries: failures.length ? failedEntries : entries,
      error_message: failures.length ? failures.join('; ') : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', checkin.id)

  // Reply with the result — cite the Harvest entry id per line so the write
  // is verifiable in Harvest (heads off "did it actually log?" re-entry).
  const summary = logged
    .map((e) => `• *${e.hours}h* — ${e.project.name} (${e.task.name}) — Harvest #${e.id}`)
    .join('\n')
  let text: string
  if (failures.length === 0) {
    text = `:white_check_mark: *Logged to Harvest* — you're all set, no need to enter these manually.\n${summary}`
  } else if (logged.length === 0 && !allEntryIds.length) {
    text = `:x: Couldn't log any entries:\n• ${failures.join('\n• ')}`
  } else if (logged.length === 0) {
    text =
      `:large_yellow_circle: The entries logged earlier remain safe and were not submitted again.\n` +
      `*Still skipped:*\n• ${failures.join('\n• ')}`
  } else {
    text = `:large_yellow_circle: Partially logged.\n*Logged:*\n${summary}\n\n*Skipped:*\n• ${failures.join('\n• ')}`
  }
  if (failures.length && allEntryIds.length) {
    await app.client.chat.postMessage({
      channel: checkin.dm_channel_id || '',
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        {
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: '✏️ Fix skipped entry only' },
            action_id: 'checkin_retry_failed',
            value: checkin.id,
          }],
        },
      ],
    })
  } else {
    await postResult({ app, channelId: checkin.dm_channel_id || '', threadTs: checkin.dm_ts, text })
  }
}

/**
 * Re-open only the unlogged remainder of a partial confirmation. Existing
 * Harvest ids stay attached to the row; the next reply replaces only the
 * failed parsed_entries and confirmation appends new ids without duplication.
 */
export async function handleCheckinRetryFailed(opts: {
  app: App
  checkinId: string
  actorSlackUserId: string
}): Promise<void> {
  const sb = createAdminClient()
  const { data: row, error } = await sb
    .from('daily_hours_checkins')
    .select('id, slack_user_id, dm_channel_id, check_in_date, status, harvest_entry_ids')
    .eq('id', opts.checkinId)
    .maybeSingle()
  if (error || !row || row.status !== 'failed' || !Array.isArray(row.harvest_entry_ids) || !row.harvest_entry_ids.length) {
    return
  }
  if (!isCheckinActorAuthorized(row.slack_user_id, opts.actorSlackUserId)) {
    console.warn(`[checkin-confirm] denied partial retry actor ${opts.actorSlackUserId || '(missing)'} for ${opts.checkinId}`)
    return
  }
  const { data: changed } = await sb
    .from('daily_hours_checkins')
    .update({
      status: 'sent',
      origin: 'partial-retry',
      parsed_entries: null,
      reply_ts: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .eq('status', 'failed')
    .select('id')
  if (!changed?.length) return
  await opts.app.client.chat.postMessage({
    channel: row.dm_channel_id || '',
    text:
      `The entries already logged to Harvest are locked and will not be submitted again. ` +
      `Reply with only the corrected skipped time for *${row.check_in_date}* (for example, \`3h on 2639\`).`,
  })
}

export async function handleCheckinRedo(opts: {
  app: App
  client: any
  body: any
  checkinId: string
  actorSlackUserId: string
}): Promise<void> {
  const { app, checkinId } = opts
  const checkin = await loadCheckin(checkinId)
  if (!checkin) return
  if (!isCheckinActorAuthorized(checkin.slack_user_id, opts.actorSlackUserId)) {
    console.warn(`[checkin-confirm] denied redo actor ${opts.actorSlackUserId || '(missing)'} for ${checkinId}`)
    return
  }

  const sb = createAdminClient()
  const { data: changed, error } = await sb
    .from('daily_hours_checkins')
    .update({
      status: 'sent',
      parsed_entries: null,
      reply_ts: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', checkin.id)
    .eq('status', 'parsed')
    .select('id')

  if (error) throw new Error(`check-in redo failed: ${error.message}`)
  if (!changed?.length) return

  await postResult({
    app,
    channelId: checkin.dm_channel_id || '',
    threadTs: checkin.dm_ts,
    text: ":arrows_counterclockwise: Cleared — go ahead and resend your hours.",
  })
}
