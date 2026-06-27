// @ts-nocheck
/**
 * Briefing composer — assembles the pre-meeting markdown body.
 *
 * Pulls context from:
 *   - projects (header, brief_summary, links)
 *   - kit_actions (open items for this project)
 *   - call_transcripts (last Plaud summary if available)
 *   - external_links (Frame.io, Dropbox)
 *
 * Output is markdown suitable for Slack chat.postMessage with mrkdwn=true.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { CalendarEvent } from '@/lib/integrations/google-calendar'

export interface BriefingContext {
  event: CalendarEvent
  projectId: string
}

export interface BriefingRecipient {
  slack_user_id: string
  email: string
  name: string | null
}

export interface BriefingArtifact {
  channelText: string
  /** R&F people actually on the invite — the ONLY recipients (privacy). */
  recipients: BriefingRecipient[]
  /** Project channel, used only when BRIEFING_POST_CHANNEL is explicitly on. */
  projectChannelId: string | null
}

/**
 * Match calendar attendees to internal R&F staff — the people who get the
 * private briefing. PRIVACY-CRITICAL: only active staff with a Slack id whose
 * email exactly matches an attendee are returned. External attendees (clients),
 * inactive staff, and anyone not on the invite are excluded, so the prep can't
 * bleed to people who weren't on the call. Pure — unit-tested.
 */
export function matchAttendeesToStaff(
  attendees: { email: string }[],
  staff: { email: string | null; slack_user_id: string | null; full_name: string | null; is_active?: boolean }[],
): BriefingRecipient[] {
  const byEmail = new Map<string, { slack_user_id: string; full_name: string | null }>()
  for (const s of staff) {
    if (!s.email || !s.slack_user_id || s.is_active === false) continue
    byEmail.set(s.email.trim().toLowerCase(), { slack_user_id: s.slack_user_id, full_name: s.full_name })
  }
  const seen = new Set<string>()
  const out: BriefingRecipient[] = []
  for (const a of attendees) {
    const email = (a.email || '').trim().toLowerCase()
    if (!email) continue
    const match = byEmail.get(email)
    if (!match || seen.has(match.slack_user_id)) continue
    seen.add(match.slack_user_id)
    out.push({ slack_user_id: match.slack_user_id, email, name: match.full_name })
  }
  return out
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

/**
 * Assemble the briefing markdown from already-fetched context. Pure — tested.
 * `lastTranscript` must already be scoped to this project by the caller.
 */
export function buildBriefingText(opts: {
  event: CalendarEvent
  project: any | null
  actions: { title: string }[] | null
  lastTranscript: { start_time: string; transcript: string } | null
}): string {
  const { event, project, actions, lastTranscript } = opts
  const lines: string[] = []
  lines.push(`:wave: *Pre-meeting briefing*`)
  lines.push(`*Meeting:* ${event.summary} — ${fmtTime(event.start_time)}`)
  if (project) {
    lines.push(
      `*Project:* ${project.name}${project.client ? ` (${project.client})` : ''}${project.project_code ? ` — ${project.project_code}` : ''}`,
    )
    if (project.brief_summary) lines.push(`*Brief:* ${project.brief_summary}`)
  }

  // Links — accept both the rehydrated *_url keys and the provisioner's bare
  // keys (the same dual-key shape the onboarding welcome DM handles).
  const el = project?.external_links || {}
  const frameio = el.frameio_url || el.frameio
  const dropbox = el.dropbox_url || el.dropbox
  const links: string[] = []
  if (frameio) links.push(`• Frame.io: ${frameio}`)
  if (dropbox) links.push(`• Dropbox: ${dropbox}`)
  if (event.hangoutLink) links.push(`• Google Meet: ${event.hangoutLink}`)
  if (links.length) {
    lines.push('', '*Links:*', ...links)
  }

  if (actions && actions.length > 0) {
    lines.push('', '*Open actions:*')
    for (const a of actions) lines.push(`• ${a.title}`)
  }

  if (lastTranscript?.transcript) {
    const snippet = lastTranscript.transcript.slice(0, 400)
    lines.push(
      '',
      `*Last meeting (${fmtTime(lastTranscript.start_time)}):* ${snippet}${snippet.length === 400 ? '…' : ''}`,
    )
  }

  if (event.attendees?.length) {
    lines.push('', `*Attendees:* ${event.attendees.map((a) => a.email).join(', ')}`)
  }

  return lines.join('\n')
}

export async function composeBriefing(ctx: BriefingContext): Promise<BriefingArtifact> {
  const { event, projectId } = ctx
  const sb = createAdminClient()

  // Project header
  const { data: project } = await sb
    .from('projects')
    .select('id, name, client, project_code, brief_summary, external_links')
    .eq('id', projectId)
    .maybeSingle()

  // Channel id
  const channelId =
    project?.external_links?.slack_id ||
    project?.external_links?.slack_channel_id ||
    null

  // Open actions
  const { data: actions } = await sb
    .from('kit_actions')
    .select('title, body, status')
    .eq('project_id', projectId)
    .in('status', ['pending', 'approved'])
    .limit(5)

  // Last Plaud summary for THIS project (scoped — an unscoped query would
  // surface another project's meeting in this briefing).
  const { data: lastTranscript } = await sb
    .from('call_transcripts')
    .select('start_time, transcript, source')
    .eq('source', 'plaud')
    .eq('project_id', projectId)
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Recipients = the R&F people actually on the invite. We DM only them, so a
  // briefing for a sensitive meeting never reaches anyone who wasn't on the
  // call. Match active staff (by email) against the event's attendees.
  const { data: staffRows } = await sb
    .from('staff')
    .select('email, slack_user_id, full_name, is_active')
    .eq('is_active', true)
  const recipients = matchAttendeesToStaff(event.attendees || [], staffRows || [])

  const channelText = buildBriefingText({ event, project, actions, lastTranscript })

  return {
    channelText,
    recipients,
    projectChannelId: channelId,
  }
}
