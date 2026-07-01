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

import Anthropic from '@anthropic-ai/sdk'
import { createAdminClient } from '@/lib/supabase/admin'
import { searchDocuments, buildContext } from '@/lib/rag/query'
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
  staff: {
    email: string | null
    email_aliases?: string[] | null
    slack_user_id: string | null
    full_name: string | null
    is_active?: boolean
  }[],
): BriefingRecipient[] {
  const byEmail = new Map<string, { slack_user_id: string; full_name: string | null }>()
  for (const s of staff) {
    if (!s.email || !s.slack_user_id || s.is_active === false) continue
    const entry = { slack_user_id: s.slack_user_id, full_name: s.full_name }
    // Primary email plus any aliases (e.g. a Slack address that differs from
    // the calendar-invite address) so briefings match regardless of which
    // address the invite used.
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
    if (!match || seen.has(match.slack_user_id)) continue
    seen.add(match.slack_user_id)
    out.push({ slack_user_id: match.slack_user_id, email, name: match.full_name })
  }
  return out
}

/**
 * Suggested prep — 2-4 bullets synthesized from the project's brain + recent
 * notes via RAG, so a briefing surfaces relevant context without the
 * recipient having to dig through the project's history themselves.
 * Non-fatal: returns null on any failure (no matching docs, missing API key,
 * model error) so a prep-notes hiccup never blocks the rest of the briefing.
 */
export async function buildProjectPrepNotes(opts: {
  projectId: string
  meetingTitle: string
  briefSummary?: string | null
}): Promise<string | null> {
  try {
    const query = [opts.meetingTitle, opts.briefSummary].filter(Boolean).join(' — ')
    const results = await searchDocuments(query, { projectId: opts.projectId, limit: 8 })
    if (results.length === 0) return null

    const context = buildContext(results, 6_000)
    if (!context.trim()) return null

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) return null
    const client = new Anthropic({ apiKey })

    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system:
        'You summarize project context into pre-meeting prep notes for a video production ' +
        'studio. Given retrieved brain/notes context and the meeting title, output 2-4 short ' +
        'bullet points (each starting with "• ") of the most relevant context, open decisions, ' +
        'or callbacks for this specific call. Be concrete and terse — no filler, no restating ' +
        'the meeting title. If the context is not actually relevant to this meeting, output ' +
        'nothing at all.',
      messages: [
        { role: 'user', content: `Meeting: ${opts.meetingTitle}\n\nRetrieved context:\n${context}` },
      ],
    })

    const text = res.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n')
      .trim()

    return text || null
  } catch (err: any) {
    console.warn('[briefing-composer] prep notes failed:', err?.message || err)
    return null
  }
}

export function fmtTime(iso: string): string {
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
  prepNotes?: string | null
}): string {
  const { event, project, actions, lastTranscript, prepNotes } = opts
  const lines: string[] = []
  lines.push(`:wave: *Pre-meeting briefing*`)
  lines.push(`*Meeting:* ${event.summary} — ${fmtTime(event.start_time)}`)
  if (project) {
    lines.push(
      `*Project:* ${project.name}${project.client ? ` (${project.client})` : ''}${project.project_code ? ` — ${project.project_code}` : ''}`,
    )
    if (project.brief_summary) lines.push(`*Brief:* ${project.brief_summary}`)
  }

  if (prepNotes) {
    lines.push('', '*Suggested prep:*', prepNotes)
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
    .select('email, email_aliases, slack_user_id, full_name, is_active')
    .eq('is_active', true)
  const recipients = matchAttendeesToStaff(event.attendees || [], staffRows || [])

  const prepNotes = project
    ? await buildProjectPrepNotes({
        projectId,
        meetingTitle: event.summary,
        briefSummary: project.brief_summary,
      })
    : null

  const channelText = buildBriefingText({ event, project, actions, lastTranscript, prepNotes })

  return {
    channelText,
    recipients,
    projectChannelId: channelId,
  }
}
