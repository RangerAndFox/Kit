// @ts-nocheck
/**
 * Pre-meeting briefings — Inngest functions.
 *
 * Two functions:
 *   1. preMeetingScan (cron, every 15m): pulls upcoming events from
 *      Google Calendar, classifies each to a project, schedules a
 *      delayed dispatch event for ~30 min before the meeting.
 *   2. preMeetingDispatch (event-triggered): composes the briefing
 *      markdown and posts to Slack.
 *
 * All side effects are gated by GOOGLE_CALENDAR_INGEST_ENABLED.
 * Spec: docs/superpowers/specs/2026-05-21-pre-meeting-briefings-design.md
 */

import { inngest } from './client'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchUpcomingEvents } from '@/lib/integrations/google-calendar'
import { classifyMeeting } from '@/lib/agent/meeting-classifier'
import { composeBriefing } from '@/lib/agent/briefing-composer'

const SLACK_API = 'https://slack.com/api'

function ingestEnabled(): boolean {
  return process.env.GOOGLE_CALENDAR_INGEST_ENABLED === 'true'
}

function leadTimeMs(): number {
  const m = Number(process.env.BRIEFING_LEAD_TIME_MINUTES) || 30
  return Math.max(5, Math.min(120, m)) * 60_000
}

function matchThreshold(): number {
  const t = Number(process.env.BRIEFING_MATCH_THRESHOLD)
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.5
}

async function postSlack(channel: string, text: string): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token || !channel) return null
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null)
  if (!res) return null
  const json = await res.json().catch(() => ({}))
  return json.ok ? json.ts : null
}

async function openDmAndPost(slackUserId: string, text: string): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token || !slackUserId) return null
  const open = await fetch(`${SLACK_API}/conversations.open`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ users: slackUserId }),
  }).catch(() => null)
  if (!open) return null
  const oj = await open.json().catch(() => ({}))
  if (!oj.ok) return null
  return postSlack(oj.channel.id, text)
}

// ─── Cron: scan for upcoming events ───────────────────────────

export const preMeetingScan = inngest.createFunction(
  {
    id: 'pre-meeting-scan',
    name: 'Pre-meeting — Scan upcoming events',
    retries: 1,
  },
  { cron: '*/15 * * * *' },
  async ({ step, logger }) => {
    if (!ingestEnabled()) {
      return { skipped: true, reason: 'GOOGLE_CALENDAR_INGEST_ENABLED is false' }
    }

    const lead = leadTimeMs()
    const now = Date.now()
    // Look ahead by lead + 16 min (one cron cycle of safety margin).
    const fromIso = new Date(now).toISOString()
    const toIso = new Date(now + lead + 16 * 60_000).toISOString()

    const events = await step.run('fetch-events', () =>
      fetchUpcomingEvents(fromIso, toIso),
    )

    const sb = createAdminClient()

    // Pull active projects once for batch classification.
    const { data: projectRows } = await sb
      .from('projects')
      .select('id, name, client, project_code, brief_summary, external_ids')
      .eq('status', 'active')
      .limit(50)

    const activeProjects = (projectRows || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      client: p.client,
      project_code: p.project_code,
      brief_summary: p.brief_summary,
      // No staff-by-project mapping yet; team_emails left empty for now.
      team_emails: [],
    }))

    let scheduled = 0
    for (const ev of events) {
      // Skip events already tracked.
      const { data: existing } = await sb
        .from('meeting_briefings')
        .select('id, status')
        .eq('event_id', ev.event_id)
        .maybeSingle()
      if (existing && existing.status !== 'failed') continue

      const cls = await step.run(`classify-${ev.event_id}`, () =>
        classifyMeeting(ev, activeProjects).catch((err) => ({
          project_id: null,
          confidence: 0,
          reasoning: `classifier error: ${err.message}`,
        })),
      )

      if (!cls.project_id || cls.confidence < matchThreshold()) {
        await sb.from('meeting_briefings').upsert(
          {
            event_id: ev.event_id,
            calendar_id: ev.calendar_id,
            meeting_title: ev.summary,
            meeting_start_time: ev.start_time,
            attendees_json: ev.attendees,
            confidence: cls.confidence,
            status: 'skipped',
            error: cls.reasoning,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'event_id', ignoreDuplicates: false },
        )
        continue
      }

      const startMs = Date.parse(ev.start_time)
      const sendMs = startMs - lead

      await sb.from('meeting_briefings').upsert(
        {
          event_id: ev.event_id,
          calendar_id: ev.calendar_id,
          project_id: cls.project_id,
          meeting_title: ev.summary,
          meeting_start_time: ev.start_time,
          attendees_json: ev.attendees,
          confidence: cls.confidence,
          status: 'pending',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'event_id', ignoreDuplicates: false },
      )

      await inngest.send({
        name: 'pre-meeting/dispatch',
        data: {
          event_id: ev.event_id,
          project_id: cls.project_id,
          event: ev,
        },
        ts: Math.max(now + 1_000, sendMs),
      })
      scheduled++
    }

    return { scheduled, scanned: events.length }
  },
)

// ─── Event: dispatch the briefing ─────────────────────────────

export const preMeetingDispatch = inngest.createFunction(
  {
    id: 'pre-meeting-dispatch',
    name: 'Pre-meeting — Send briefing',
    retries: 2,
    idempotency: 'event.data.event_id',
    triggers: [{ event: 'pre-meeting/dispatch' }],
  },
  async ({ event, step }) => {
    if (!ingestEnabled()) {
      return { skipped: true }
    }
    const { event_id, project_id, event: calendarEvent } = event.data

    const artifact = await step.run('compose', () =>
      composeBriefing({ event: calendarEvent, projectId: project_id }),
    )

    const channelTs = artifact.projectChannelId
      ? await step.run('post-channel', () =>
          postSlack(artifact.projectChannelId!, artifact.channelText),
        )
      : null

    const dmTs = artifact.producerSlackUserId && artifact.producerDmText
      ? await step.run('dm-producer', () =>
          openDmAndPost(artifact.producerSlackUserId!, artifact.producerDmText!),
        )
      : null

    const sb = createAdminClient()
    await sb
      .from('meeting_briefings')
      .update({
        briefing_md: artifact.channelText,
        slack_channel_id: artifact.projectChannelId,
        slack_message_ts: channelTs,
        producer_dm_ts: dmTs,
        status: 'sent',
        updated_at: new Date().toISOString(),
      })
      .eq('event_id', event_id)

    return { sent: true, channelTs, dmTs }
  },
)
