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

export interface BriefingArtifact {
  channelText: string
  producerDmText: string | null
  projectChannelId: string | null
  producerSlackUserId: string | null
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
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
    .select('title, description, status')
    .eq('payload->>projectId', projectId)
    .in('status', ['suggested', 'acknowledged'])
    .limit(5)

  // Last Plaud summary if any
  const { data: lastTranscript } = await sb
    .from('call_transcripts')
    .select('start_time, transcript, source')
    .eq('source', 'plaud')
    .order('start_time', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Producer DM target: best-effort lookup of a producer in staff for this workspace.
  const { data: producer } = await sb
    .from('staff')
    .select('slack_user_id')
    .eq('role', 'producer')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()

  // Compose channel post
  const lines: string[] = []
  lines.push(`:wave: *Pre-meeting briefing*`)
  lines.push(`*Meeting:* ${event.summary} — ${fmtTime(event.start_time)}`)
  if (project) {
    lines.push(`*Project:* ${project.name}${project.client ? ` (${project.client})` : ''}${project.project_code ? ` — ${project.project_code}` : ''}`)
    if (project.brief_summary) lines.push(`*Brief:* ${project.brief_summary}`)
  }

  // Links
  const links: string[] = []
  if (project?.external_links?.frameio_url) links.push(`• Frame.io: ${project.external_links.frameio_url}`)
  if (project?.external_links?.dropbox_url) links.push(`• Dropbox: ${project.external_links.dropbox_url}`)
  if (event.hangoutLink) links.push(`• Google Meet: ${event.hangoutLink}`)
  if (links.length) {
    lines.push('')
    lines.push('*Links:*')
    lines.push(...links)
  }

  // Open actions
  if (actions && actions.length > 0) {
    lines.push('')
    lines.push('*Open actions:*')
    for (const a of actions) {
      lines.push(`• ${a.title}`)
    }
  }

  // Last meeting recap
  if (lastTranscript?.transcript) {
    const snippet = lastTranscript.transcript.slice(0, 400)
    lines.push('')
    lines.push(`*Last meeting (${fmtTime(lastTranscript.start_time)}):* ${snippet}${snippet.length === 400 ? '…' : ''}`)
  }

  // Attendees
  if (event.attendees.length) {
    lines.push('')
    lines.push(`*Attendees:* ${event.attendees.map((a) => a.email).join(', ')}`)
  }

  const channelText = lines.join('\n')

  // Producer DM — same body plus a private nudge
  let producerDmText: string | null = null
  if (producer?.slack_user_id) {
    producerDmText = `${channelText}\n\n_Producer ping: anything you want surfaced before the call? Reply here._`
  }

  return {
    channelText,
    producerDmText,
    projectChannelId: channelId,
    producerSlackUserId: producer?.slack_user_id || null,
  }
}
