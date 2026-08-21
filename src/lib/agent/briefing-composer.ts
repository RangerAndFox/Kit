// @ts-nocheck
/**
 * Meeting briefing composer.
 *
 * Every supported meeting type uses the same deliberately small layout:
 * meeting information, public background on external attendees, and one
 * positioning paragraph. Delivery remains private to internal R&F invitees.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { CalendarEvent } from '@/lib/integrations/google-calendar'
import type { AttendeeEvidence } from './bizdev-briefing'

export interface BriefingContext {
  event: CalendarEvent
  projectId: string
}

export interface BriefingRecipient {
  /** Authoritative internal identity (staff.id) — the delivery-ledger key. */
  staff_id: string
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

export interface BriefingProject {
  name: string
  client?: string | null
  project_code?: string | null
  brief_summary?: string | null
}

export interface ExternalAttendee {
  email: string
  displayName?: string
  responseStatus?: string
}

/**
 * Match calendar attendees to internal R&F staff — the people who receive the
 * private briefing. External attendees are never delivery recipients.
 */
export function matchAttendeesToStaff(
  attendees: { email: string }[],
  staff: {
    id: string
    email: string | null
    email_aliases?: string[] | null
    slack_user_id: string | null
    full_name: string | null
    is_active?: boolean
  }[],
): BriefingRecipient[] {
  const byEmail = new Map<
    string,
    { staff_id: string; slack_user_id: string; full_name: string | null }
  >()
  for (const s of staff) {
    if (!s.id || !s.email || !s.slack_user_id || s.is_active === false) continue
    const entry = { staff_id: s.id, slack_user_id: s.slack_user_id, full_name: s.full_name }
    byEmail.set(s.email.trim().toLowerCase(), entry)
    for (const alias of s.email_aliases || []) {
      if (alias && alias.trim()) byEmail.set(alias.trim().toLowerCase(), entry)
    }
  }
  const seen = new Set<string>()
  const out: BriefingRecipient[] = []
  for (const a of attendees) {
    const email = (a.email || '').trim().toLowerCase()
    if (!email) continue
    const match = byEmail.get(email)
    if (!match || seen.has(match.staff_id)) continue
    seen.add(match.staff_id)
    out.push({
      staff_id: match.staff_id,
      slack_user_id: match.slack_user_id,
      email,
      name: match.full_name,
    })
  }
  return out
}

function briefingTimezone(): string {
  return process.env.BRIEFING_TIMEZONE || process.env.CHECKIN_TIMEZONE || 'America/Detroit'
}

export function fmtTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: briefingTimezone(),
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

export function fmtMeetingRange(startIso: string, endIso?: string): string {
  const start = fmtTime(startIso)
  if (!endIso || endIso === startIso) return start
  try {
    const end = new Intl.DateTimeFormat('en-US', {
      timeZone: briefingTimezone(),
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(endIso))
    return `${start}–${end}`
  } catch {
    return start
  }
}

function cleanSentence(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim().replace(/^[•\-]\s*/, '')
  if (!text) return ''
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/**
 * Compact public background for one external attendee. Internal history may
 * help research resolve identity, but only public facts/inferences are rendered
 * in this section because its contract is specifically LinkedIn/web context.
 */
export function renderExternalAttendeeBackground(
  attendee: ExternalAttendee,
  evidence: AttendeeEvidence | null,
): string {
  const name = evidence?.identity?.name || attendee.displayName || attendee.email
  if (!evidence || evidence.identity.status === 'unresolved') {
    return `*${name}:* No reliable public background found.`
  }

  const publicFacts = (evidence.facts || [])
    .filter((fact) => /^https?:\/\//i.test(String(fact.source_ref || '')))
    .map((fact) => cleanSentence(fact.claim))
    .filter(Boolean)
    .slice(0, 3)
  const background = [...publicFacts]

  if (background.length === 0 && evidence.identity.company) {
    background.push(
      `Public signals associate ${name} with ${evidence.identity.company}, but Kit could not verify a specific role or profile.`,
    )
  }

  return `*${name}:* ${background.join(' ') || 'No reliable public background found.'}`
}

/** Shared concise layout for bizdev, kickoff, and active-project meetings. */
export function buildMeetingBriefingText(opts: {
  event: CalendarEvent
  project?: BriefingProject | null
  externals: ExternalAttendee[]
  evidence: (AttendeeEvidence | null)[]
  positioning: string
}): string {
  const { event, project, externals, evidence, positioning } = opts
  const lines: string[] = [
    '*Meeting info*',
    `*Subject:* ${event.summary || 'Untitled meeting'}`,
    `*Date & time:* ${fmtMeetingRange(event.start_time, event.end_time)}`,
  ]

  if (project) {
    const identity = [project.project_code, project.name].filter(Boolean).join(' | ')
    lines.push(`*Project:* ${identity}${project.client ? ` — ${project.client}` : ''}`)
  }
  if (event.hangoutLink) lines.push(`*Join:* ${event.hangoutLink}`)

  lines.push('', '*Attendee info*')
  if (externals.length === 0) {
    lines.push('_No external attendees on this invite._')
  } else {
    externals.forEach((attendee, index) => {
      lines.push(renderExternalAttendeeBackground(attendee, evidence[index] || null))
    })
  }

  lines.push('', '*Positioning*', positioning)
  return lines.join('\n')
}

/** Project-meeting wrapper retained as the public composer test seam. */
export function buildBriefingText(opts: {
  event: CalendarEvent
  project: BriefingProject | null
  externals: ExternalAttendee[]
  evidence: (AttendeeEvidence | null)[]
  positioning: string
}): string {
  return buildMeetingBriefingText(opts)
}

export async function composeBriefing(ctx: BriefingContext): Promise<BriefingArtifact> {
  const { event, projectId } = ctx
  const sb = createAdminClient()

  const [{ data: project }, { data: staffRows }] = await Promise.all([
    sb
      .from('projects')
      .select('id, name, client, project_code, brief_summary, external_links')
      .eq('id', projectId)
      .maybeSingle(),
    sb
      .from('staff')
      .select('id, email, email_aliases, slack_user_id, full_name, is_active')
      .eq('is_active', true),
  ])

  const projectChannelId =
    project?.external_links?.slack_id ||
    project?.external_links?.slack_channel_id ||
    null
  const recipients = matchAttendeesToStaff(event.attendees || [], staffRows || [])

  // Dynamic import avoids a runtime cycle: bizdev-briefing imports the shared
  // layout above, while project briefings reuse its normalized research path.
  const {
    buildStaffEmailSet,
    filterExternalAttendees,
    researchAttendee,
    buildPositioningParagraph,
  } = await import('./bizdev-briefing')
  const internalEmails = buildStaffEmailSet(staffRows || [])
  const externals = filterExternalAttendees(event.attendees || [], internalEmails)
  const evidence = await Promise.all(externals.map((attendee) => researchAttendee(attendee, event)))
  const positioning = await buildPositioningParagraph({ event, project, externals, evidence })

  return {
    channelText: buildBriefingText({ event, project, externals, evidence, positioning }),
    recipients,
    projectChannelId,
  }
}
