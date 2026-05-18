// @ts-nocheck
/**
 * Daily Hours Check-in — Reply Parser + Confirmation
 *
 * When a creative DMs Kit while they have an open check-in (status='sent'
 * or 'nudged' for today), this module:
 *   1. Parses the natural-language reply with Claude Haiku into structured
 *      { projectQuery, hours, notes }[] entries.
 *   2. Resolves each projectQuery to a real Harvest project via search.
 *   3. Posts a confirmation Block Kit card with Confirm / Edit buttons.
 *   4. Stores parsed_entries on the check-in row, status='parsed'.
 *
 * The Confirm button is wired in handlers/interactions.ts.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import {
  searchProjects,
  type HarvestProject,
} from '../../../src/lib/harvest/client'
import { anthropic, SPECIALIST_MODEL } from '../llm/client'

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
  // Resolved after Harvest lookup:
  harvest_project_id?: number
  harvest_project_name?: string
  resolution: 'matched' | 'ambiguous' | 'unmatched'
  candidates?: { id: number; name: string }[]
}

/**
 * Return the open check-in row for this user today, or null if none.
 * Open = status in ('sent', 'nudged') for today's date.
 */
export async function findOpenCheckin(slackUserId: string): Promise<OpenCheckin | null> {
  const today = new Date().toISOString().split('T')[0]
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('daily_hours_checkins')
    .select(
      'id, staff_id, slack_user_id, check_in_date, status, dm_channel_id, dm_ts, candidate_projects',
    )
    .eq('slack_user_id', slackUserId)
    .eq('check_in_date', today)
    .in('status', ['sent', 'nudged'])
    .maybeSingle()
  if (error) {
    console.warn(`[checkin-reply] findOpenCheckin failed: ${error.message}`)
    return null
  }
  return (data as OpenCheckin) || null
}

/**
 * Parse a natural-language hours reply into structured entries.
 * Uses Claude Haiku — fast, cheap, deterministic enough for this.
 */
export async function parseReplyWithLLM(opts: {
  replyText: string
  candidateProjects: { harvest_project_name: string }[]
}): Promise<{ entries: { projectQuery: string; hours: number; notes?: string }[]; skip: boolean }> {
  const { replyText, candidateProjects } = opts
  const candidateList = candidateProjects
    .map((c) => `- ${c.harvest_project_name}`)
    .join('\n')

  const systemPrompt = `You parse short messages from creatives logging daily hours.

Output strict JSON with this shape:
{
  "skip": boolean,
  "entries": [ { "projectQuery": string, "hours": number, "notes": string | null } ]
}

Rules:
- If the user says "skip", "off today", "didn't work", "no work", etc → skip=true, entries=[].
- Otherwise extract each (project, hours) pair from the message.
- "projectQuery" should be the project name as the user said it (no normalization needed — we'll fuzzy-match it ourselves).
- "hours" must be a number (parse "4h" → 4, "2.5 hours" → 2.5, "30 min" → 0.5).
- "notes" is anything they added after the hours (or null).
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
}) {
  const { checkinId, entries } = opts
  const lines = entries.map((e) => {
    if (e.resolution === 'matched') {
      const note = e.notes ? ` _(${e.notes})_` : ''
      return `• *${e.hours}h* — ${e.harvest_project_name}${note}`
    }
    if (e.resolution === 'ambiguous') {
      const opts = (e.candidates || []).map((c) => c.name).join(' / ')
      return `• *${e.hours}h* — _"${e.projectQuery}"_ ⚠️ multiple matches: ${opts}`
    }
    return `• *${e.hours}h* — _"${e.projectQuery}"_ ❌ no Harvest project matched`
  })
  const allMatched = entries.every((e) => e.resolution === 'matched')

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Logging to Harvest:*\n${lines.join('\n')}`,
      },
    },
    {
      type: 'actions',
      elements: allMatched
        ? [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Confirm & log' },
              style: 'primary',
              action_id: 'checkin_confirm',
              value: checkinId,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '✏️ Redo' },
              action_id: 'checkin_redo',
              value: checkinId,
            },
          ]
        : [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✏️ Try again' },
              action_id: 'checkin_redo',
              value: checkinId,
            },
          ],
    },
  ]
}

/**
 * Handle a DM reply when an open check-in exists.
 * Returns true if the message was handled (caller should NOT route to orchestrator).
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

  // Mark replied immediately so concurrent messages don't double-fire.
  await sb
    .from('daily_hours_checkins')
    .update({ status: 'replied', reply_ts: replyTs, updated_at: new Date().toISOString() })
    .eq('id', open.id)

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
      thread_ts: open.dm_ts || undefined,
      text: ':+1: Marked as skipped. Talk tomorrow.',
    })
    return true
  }

  let parsed: { entries: any[]; skip: boolean }
  try {
    parsed = await parseReplyWithLLM({
      replyText,
      candidateProjects: open.candidate_projects || [],
    })
  } catch (err: any) {
    console.warn(`[checkin-reply] parse failed: ${err.message}`)
    await app.client.chat.postMessage({
      channel: open.dm_channel_id,
      thread_ts: open.dm_ts || undefined,
      text:
        ":thinking_face: I couldn't parse that. Try a format like: _'4h on Rayfin, 2h on IQ Sizzle'_ — or reply `skip`.",
    })
    return true
  }

  if (parsed.skip) {
    await sb.from('daily_hours_checkins').update({ status: 'skipped' }).eq('id', open.id)
    await app.client.chat.postMessage({
      channel: open.dm_channel_id,
      thread_ts: open.dm_ts || undefined,
      text: ':+1: Marked as skipped.',
    })
    return true
  }

  if (parsed.entries.length === 0) {
    await app.client.chat.postMessage({
      channel: open.dm_channel_id,
      thread_ts: open.dm_ts || undefined,
      text:
        ":thinking_face: I didn't pull any entries from that. Try _'4h on <project>'_, or reply `skip`.",
    })
    return true
  }

  // Resolve each entry against Harvest in parallel.
  const resolved: ParsedEntry[] = await Promise.all(
    parsed.entries.map(async (e: any) => {
      const r = await resolveHarvestProject(e.projectQuery)
      return {
        projectQuery: e.projectQuery,
        hours: Number(e.hours),
        notes: e.notes || undefined,
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
    thread_ts: open.dm_ts || undefined,
    text: 'Confirm hours',
    blocks: buildConfirmBlocks({ checkinId: open.id, entries: resolved }),
  })

  return true
}
