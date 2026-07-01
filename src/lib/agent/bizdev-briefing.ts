// @ts-nocheck
/**
 * Bizdev briefing — the meeting composer used when a calendar event doesn't
 * match any active project but a bizdev-role staffer (e.g. Erin) is on the
 * invite. Instead of project context, it looks up each external attendee on
 * the web and writes a short bio + relevance to Ranger & Fox.
 *
 * Delivery follows the same privacy rule as project briefings: only R&F
 * attendees actually on the invite receive it (see matchAttendeesToStaff in
 * briefing-composer.ts), via their private per-person channel.
 */

import Anthropic from '@anthropic-ai/sdk'
import { createAdminClient } from '@/lib/supabase/admin'
import type { CalendarEvent } from '@/lib/integrations/google-calendar'
import { matchAttendeesToStaff, fmtTime, type BriefingRecipient } from './briefing-composer'

export interface BizdevBriefingArtifact {
  channelText: string
  recipients: BriefingRecipient[]
}

/**
 * True if any attendee email (or alias) belongs to a bizdev-role staffer.
 * Pure — unit-tested. Gates the whole bizdev path: without a bizdev staffer
 * on the invite, an unmatched meeting stays silently skipped as before.
 */
export function hasBizdevAttendee(
  attendeeEmails: string[],
  bizdevEmails: Set<string>,
): boolean {
  return attendeeEmails.some((e) => bizdevEmails.has((e || '').trim().toLowerCase()))
}

/** Builds the lowercased (email + aliases) set for a set of staff rows. Pure. */
export function buildStaffEmailSet(
  staff: { email: string | null; email_aliases?: string[] | null }[],
): Set<string> {
  const set = new Set<string>()
  for (const s of staff) {
    if (s.email) set.add(s.email.trim().toLowerCase())
    for (const alias of s.email_aliases || []) {
      if (alias && alias.trim()) set.add(alias.trim().toLowerCase())
    }
  }
  return set
}

/**
 * Attendees who are NOT internal R&F staff — the people we look up. Pure —
 * unit-tested. Uses the full staff email set (not just staff with a Slack
 * id), so an internal staffer without a Slack account is never mistaken for
 * an external contact and web-searched.
 */
export function filterExternalAttendees(
  attendees: { email: string; displayName?: string }[],
  internalEmails: Set<string>,
): { email: string; displayName?: string }[] {
  return attendees.filter((a) => {
    const email = (a.email || '').trim().toLowerCase()
    return email && !internalEmails.has(email)
  })
}

/**
 * Assemble the bizdev briefing markdown from already-fetched context. Pure —
 * unit-tested.
 */
export function buildBizdevBriefingText(opts: {
  event: CalendarEvent
  externals: { email: string; displayName?: string }[]
  bios: (string | null)[]
}): string {
  const { event, externals, bios } = opts
  const lines: string[] = []
  lines.push(':wave: *Pre-meeting briefing (business development)*')
  lines.push(`*Meeting:* ${event.summary} — ${fmtTime(event.start_time)}`)

  if (externals.length === 0) {
    lines.push('', '_No external attendees found on this invite._')
    return lines.join('\n')
  }

  lines.push('', '*Attendees:*')
  externals.forEach((a, i) => {
    lines.push(`• *${a.displayName || a.email}* (${a.email})`)
    const bio = bios[i]
    if (bio) {
      for (const line of bio.split('\n')) lines.push(`  ${line}`)
    } else {
      lines.push('  _No reliable info found._')
    }
  })

  return lines.join('\n')
}

/**
 * Web-search a single external attendee and write a short bio + relevance to
 * R&F. Non-fatal: returns null on any failure (no API key, search/model
 * error) so one bad lookup doesn't block the rest of the briefing.
 */
async function buildAttendeeBio(attendee: { email: string; displayName?: string }): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  try {
    const client = new Anthropic({ apiKey })
    const who = attendee.displayName ? `${attendee.displayName} (${attendee.email})` : attendee.email

    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      system:
        'You research a meeting attendee ahead of a business-development call for Ranger & Fox, ' +
        'a creative video production studio. Search the web for the person and write a 2-3 ' +
        'sentence bio: who they are, their role/company, and anything relevant to R&F doing ' +
        'business with them (industry overlap, notable work, potential project fit). If you ' +
        'cannot find reliable public information, say so in one short sentence instead of ' +
        'guessing.',
      messages: [{ role: 'user', content: `Look up: ${who}` }],
    })

    const text = res.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n')
      .trim()

    return text || null
  } catch (err: any) {
    console.warn(`[bizdev-briefing] bio lookup failed for ${attendee.email}:`, err?.message || err)
    return null
  }
}

export async function composeBizdevBriefing(ctx: { event: CalendarEvent }): Promise<BizdevBriefingArtifact> {
  const { event } = ctx
  const sb = createAdminClient()

  const { data: staffRows } = await sb
    .from('staff')
    .select('email, email_aliases, slack_user_id, full_name, is_active')
    .eq('is_active', true)

  // Recipients = the R&F people actually on the invite (same privacy rule as
  // project briefings).
  const recipients = matchAttendeesToStaff(event.attendees || [], staffRows || [])

  // Externals = everyone NOT recognized as internal staff (broader than the
  // recipient set, which additionally requires a Slack id).
  const internalEmails = buildStaffEmailSet(staffRows || [])
  const externals = filterExternalAttendees(event.attendees || [], internalEmails)

  const bios = await Promise.all(externals.map((a) => buildAttendeeBio(a)))

  const channelText = buildBizdevBriefingText({ event, externals, bios })

  return { channelText, recipients }
}
