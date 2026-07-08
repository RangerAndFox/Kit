// @ts-nocheck
/**
 * Daily Hours Check-in — Reply Parser + Confirmation
 *
 * When a creative DMs Kit while they have an open check-in (status='sent'
 * or 'nudged' for today), this module:
 *   1. Parses the natural-language reply with Claude Haiku into structured
 *      { projectQuery, hours, notes }[] entries.
 *   2. Resolves each projectQuery to a real Harvest project via search.
 *   3. Posts a confirmation card (text-only — reply "yes" to log, "redo"
 *      to start over; Slack never delivered this app's button clicks).
 *   4. Stores parsed_entries on the check-in row, status='parsed'.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import {
  searchProjects,
  type HarvestProject,
} from '../../../src/lib/harvest/client'
import { anthropic, SPECIALIST_MODEL } from '../llm/client'
import { checkinToday, checkinDateMinusDays, resolveSpentDate, formatShortDate } from './date'
import { handleCheckinConfirm, handleCheckinRedo } from './confirm'

interface OpenCheckin {
  id: string
  staff_id: string
  slack_user_id: string
  check_in_date: string
  status: string
  dm_channel_id: string | null
  dm_ts: string | null
  candidate_projects: any
}

export interface ParsedEntry {
  projectQuery: string
  hours: number
  notes?: string
  /** Day to log to (YYYY-MM-DD). Defaults to the check-in day. */
  spentDate?: string
  // Resolved after Harvest lookup:
  harvest_project_id?: number
  harvest_project_name?: string
  resolution: 'matched' | 'ambiguous' | 'unmatched'
  candidates?: { id: number; name: string }[]
}

/**
 * Return the open check-in row for this user, or null if none.
 * Open = status in ('sent', 'nudged') within the last two calendar days —
 * check_in_date is stamped in the USER's timezone (which may differ from
 * the studio's), so an exact studio-today match would miss rows around
 * midnight boundaries.
 */
export async function findOpenCheckin(slackUserId: string): Promise<OpenCheckin | null> {
  const sb = createAdminClient()
  // limit(1) instead of maybeSingle(): if a redo + the scheduled send ever
  // produce two open rows, maybeSingle() errors and ALL replies leak past the
  // check-in interceptor. Prefer the newest open row instead.
  const { data, error } = await sb
    .from('daily_hours_checkins')
    .select(
      'id, staff_id, slack_user_id, check_in_date, status, dm_channel_id, dm_ts, candidate_projects',
    )
    .eq('slack_user_id', slackUserId)
    .gte('check_in_date', checkinDateMinusDays(2))
    .in('status', ['sent', 'nudged'])
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) {
    console.warn(`[checkin-reply] findOpenCheckin failed: ${error.message}`)
    return null
  }
  return (data?.[0] as OpenCheckin) || null
}

/**
 * Interpret a short reply as a confirm/redo decision on a parsed check-in.
 * Deliberately strict: the ENTIRE message must be a known phrase, so
 * "yes but what's the Frame.io link?" never silently logs hours. Pure —
 * unit-tested.
 */
const CONFIRM_TEXT_RE =
  /^(?:yes|y|yep|yup|yeah|confirm|confirmed|correct|looks good|lgtm|log it|log them|do it|send it|go ahead|:white_check_mark:|:thumbsup:|✅|👍)[.!\s]*$/i
const REDO_TEXT_RE =
  /^(?:no|nope|redo|edit|change|wrong|start over|try again|:pencil2:|✏️)[.!\s]*$/i

export function parseConfirmDecision(text: string): 'confirm' | 'redo' | null {
  const trimmed = (text || '').trim()
  if (!trimmed || trimmed.length > 40) return null
  if (CONFIRM_TEXT_RE.test(trimmed)) return 'confirm'
  if (REDO_TEXT_RE.test(trimmed)) return 'redo'
  return null
}

/**
 * The user's most recent check-in awaiting confirmation (status='parsed'),
 * capped at a week old so a typed "yes" can never resurrect stale hours.
 */
export async function findParsedCheckin(slackUserId: string): Promise<OpenCheckin | null> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('daily_hours_checkins')
    .select(
      'id, staff_id, slack_user_id, check_in_date, status, dm_channel_id, dm_ts, candidate_projects',
    )
    .eq('slack_user_id', slackUserId)
    .eq('status', 'parsed')
    .gte('check_in_date', weekAgo)
    .order('check_in_date', { ascending: false })
    .limit(1)
  if (error) {
    console.warn(`[checkin-reply] findParsedCheckin failed: ${error.message}`)
    return null
  }
  return (data?.[0] as OpenCheckin) || null
}

/**
 * Text fallback for the confirmation card's buttons: a typed "yes"/"redo"
 * completes or resets the pending check-in. Exists because button clicks
 * travel a different Slack delivery path than messages, and only messages
 * are verifiably reaching us — the check-in flow must not depend on the
 * flakier of the two. Returns true when the message was consumed.
 */
export async function handleParsedCheckinText(opts: {
  app: App
  slackUserId: string
  replyText: string
}): Promise<boolean> {
  const decision = parseConfirmDecision(opts.replyText)
  if (!decision) return false
  const parsedRow = await findParsedCheckin(opts.slackUserId)
  if (!parsedRow) return false
  if (decision === 'confirm') {
    await handleCheckinConfirm({
      app: opts.app,
      client: opts.app.client,
      body: {},
      checkinId: parsedRow.id,
    })
  } else {
    await handleCheckinRedo({
      app: opts.app,
      client: opts.app.client,
      body: {},
      checkinId: parsedRow.id,
    })
  }
  return true
}

/**
 * Parse a natural-language hours reply into structured entries.
 * Uses Claude Haiku — fast, cheap, deterministic enough for this.
 */
export async function parseReplyWithLLM(opts: {
  replyText: string
  candidateProjects: { harvest_project_name: string }[]
  /** Today's date (YYYY-MM-DD, studio tz) — the anchor for relative days. */
  today?: string
}): Promise<{
  entries: { projectQuery: string; hours: number; notes?: string; date?: string | null }[]
  skip: boolean
}> {
  const { replyText, candidateProjects } = opts
  const today = opts.today || checkinToday()
  const candidateList = candidateProjects
    .map((c) => `- ${c.harvest_project_name}`)
    .join('\n')

  const systemPrompt = `You parse short messages from creatives logging daily hours.

Today's date is ${today}.

Output strict JSON with this shape:
{
  "skip": boolean,
  "entries": [ { "projectQuery": string, "hours": number, "notes": string | null, "date": string | null } ]
}

Rules:
- If the user says "skip", "off today", "didn't work", "no work", etc → skip=true, entries=[].
- Otherwise extract each (project, hours) pair from the message.
- "projectQuery" should be the project name as the user said it (no normalization needed — we'll fuzzy-match it ourselves).
- "hours" must be a number (parse "4h" → 4, "2.5 hours" → 2.5, "30 min" → 0.5).
- "notes" is anything they added after the hours (or null).
- "date": if the user names a day for an entry ("yesterday", "Monday", "June 20"), resolve it to an absolute YYYY-MM-DD relative to today's date above. If no day is mentioned, use null (we'll default it to today). Never use a future date.
- If the user just gives bare numbers in order matching the candidate list, map them positionally.

The user was offered these candidate projects (in order):
${candidateList || '(none — they have to name projects themselves)'}

Return ONLY the JSON object, no prose, no code fences.`

  const res = await anthropic.messages.create({
    model: SPECIALIST_MODEL,
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: replyText }],
  })

  const text =
    res.content
      ?.filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('') || ''
  // Strip code fences if the model added them.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  let parsed: any
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error(`LLM returned non-JSON: ${text.slice(0, 200)}`)
  }
  return {
    skip: !!parsed.skip,
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
  }
}

/**
 * Resolve a free-form project query against Harvest. Returns one match,
 * or a list of candidates if ambiguous.
 */
export async function resolveHarvestProject(query: string): Promise<{
  resolution: 'matched' | 'ambiguous' | 'unmatched'
  project?: HarvestProject
  candidates?: HarvestProject[]
}> {
  const matches = await searchProjects(query)
  if (matches.length === 0) return { resolution: 'unmatched' }
  if (matches.length === 1) return { resolution: 'matched', project: matches[0] }
  // Prefer exact name match if present.
  const exact = matches.find((p) => p.name.toLowerCase() === query.toLowerCase())
  if (exact) return { resolution: 'matched', project: exact }
  // Otherwise return top 3 as ambiguous candidates.
  return { resolution: 'ambiguous', candidates: matches.slice(0, 3) }
}

/**
 * Render the Block Kit confirmation card.
 */
export function buildConfirmBlocks(opts: {
  checkinId: string
  entries: ParsedEntry[]
  /** The check-in day; entries logged to a different day are labelled. */
  anchorDate?: string
}) {
  const { entries, anchorDate } = opts
  const dayLabel = (e: ParsedEntry) =>
    e.spentDate && e.spentDate !== anchorDate ? ` _[${formatShortDate(e.spentDate)}]_` : ''
  const lines = entries.map((e) => {
    if (e.resolution === 'matched') {
      const note = e.notes ? ` _(${e.notes})_` : ''
      return `• *${e.hours}h* — ${e.harvest_project_name}${dayLabel(e)}${note}`
    }
    if (e.resolution === 'ambiguous') {
      const opts = (e.candidates || []).map((c) => c.name).join(' / ')
      return `• *${e.hours}h* — _"${e.projectQuery}"_ ⚠️ multiple matches: ${opts}`
    }
    return `• *${e.hours}h* — _"${e.projectQuery}"_ ❌ no Harvest project matched`
  })
  const allMatched = entries.every((e) => e.resolution === 'matched')

  // Text-only confirmation — no buttons. Slack has never delivered this
  // app's block_actions clicks (interactivity is on, socket healthy,
  // events flow; clicks vanish), so buttons sat dead and read as broken.
  // The typed path is the reliable one.
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Logging to Harvest:*\n${lines.join('\n')}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: allMatched
            ? 'Reply *yes* to log it, or *redo* to start over.'
            : 'Reply *redo* to start over, then resend your hours.',
        },
      ],
    },
  ]
}

/**
 * Handle a DM reply when an open check-in exists.
 * Returns true if the message was handled (caller should NOT route to orchestrator).
 *
 * Routing contract: the check-in must never swallow an unrelated DM. A reply
 * that parses to zero entries (and isn't a skip) is treated as "not an hours
 * message" — the check-in re-opens and the message falls through to the
 * normal pipeline. A parse FAILURE also re-opens the row so the user's retry
 * (or `skip`) is intercepted again instead of dead-ending.
 */
export async function handleCheckinReply(opts: {
  app: App
  open: OpenCheckin
  replyText: string
  replyTs: string
}): Promise<boolean> {
  const { app, open, replyText, replyTs } = opts
  const sb = createAdminClient()

  if (!open.dm_channel_id) return false

  // Claim the row (compare-and-set on the open statuses) so two rapid
  // messages don't both run the parser. Losing the race means another
  // message is mid-parse — let this one fall through to the orchestrator.
  const { data: claimed } = await sb
    .from('daily_hours_checkins')
    .update({ status: 'replied', reply_ts: replyTs, updated_at: new Date().toISOString() })
    .eq('id', open.id)
    .in('status', ['sent', 'nudged'])
    .select('id')
  if (!claimed || claimed.length === 0) return false

  // Re-open the check-in (undo the claim) — used on every path where this
  // message turned out not to complete the check-in.
  const reopen = () =>
    sb
      .from('daily_hours_checkins')
      .update({ status: 'sent', updated_at: new Date().toISOString() })
      .eq('id', open.id)
      .eq('status', 'replied')

  // Skip path
  const trimmed = replyText.trim().toLowerCase()
  if (
    trimmed === 'skip' ||
    trimmed === 'off' ||
    trimmed === 'no work' ||
    trimmed === "didn't work" ||
    trimmed === 'pto'
  ) {
    await sb
      .from('daily_hours_checkins')
      .update({ status: 'skipped' })
      .eq('id', open.id)
    await app.client.chat.postMessage({
      channel: open.dm_channel_id,
      text: ':+1: Marked as skipped. Talk tomorrow.',
    })
    return true
  }

  let parsed: { entries: any[]; skip: boolean }
  try {
    parsed = await parseReplyWithLLM({
      replyText,
      candidateProjects: open.candidate_projects || [],
      today: open.check_in_date,
    })
  } catch (err: any) {
    console.warn(`[checkin-reply] parse failed: ${err.message}`)
    await reopen()
    await app.client.chat.postMessage({
      channel: open.dm_channel_id,
      text:
        ":thinking_face: I couldn't parse that. Try a format like: _'4h on Rayfin, 2h on IQ Sizzle'_ — or reply `skip`.",
    })
    return true
  }

  if (parsed.skip) {
    await sb.from('daily_hours_checkins').update({ status: 'skipped' }).eq('id', open.id)
    await app.client.chat.postMessage({
      channel: open.dm_channel_id,
      text: ':+1: Marked as skipped.',
    })
    return true
  }

  if (parsed.entries.length === 0) {
    // Not an hours message at all (e.g. "what's the Frame.io link?").
    // Re-open the check-in and let the orchestrator answer the question.
    await reopen()
    return false
  }

  // Resolve each entry against Harvest in parallel.
  const resolved: ParsedEntry[] = await Promise.all(
    parsed.entries.map(async (e: any) => {
      const r = await resolveHarvestProject(e.projectQuery)
      return {
        projectQuery: e.projectQuery,
        hours: Number(e.hours),
        notes: e.notes || undefined,
        spentDate: resolveSpentDate(e.date, open.check_in_date),
        resolution: r.resolution,
        harvest_project_id: r.project?.id,
        harvest_project_name: r.project?.name,
        candidates:
          r.candidates?.map((c) => ({ id: c.id, name: c.name })) || undefined,
      }
    }),
  )

  // Stash on the row.
  await sb
    .from('daily_hours_checkins')
    .update({
      status: 'parsed',
      parsed_entries: resolved,
      updated_at: new Date().toISOString(),
    })
    .eq('id', open.id)

  // Post confirmation card threaded under the original DM.
  await app.client.chat.postMessage({
    channel: open.dm_channel_id,
    text: 'Confirm hours',
    blocks: buildConfirmBlocks({
      checkinId: open.id,
      entries: resolved,
      anchorDate: open.check_in_date,
    }),
  })

  return true
}
