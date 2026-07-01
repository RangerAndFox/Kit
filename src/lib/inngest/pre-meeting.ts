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
import { resolvePersonalBriefingChannel } from '@/lib/agent/briefing-channel'

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

async function postSlack(channel: string, text: string): Promise<string> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN not set')
  if (!channel) throw new Error('channel required for postSlack')
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text, mrkdwn: true }),
    signal: AbortSignal.timeout(8_000),
  })
  const json = await res.json().catch(() => ({}))
  if (!json.ok) throw new Error(`chat.postMessage failed: ${json.error || res.status}`)
  return json.ts
}

/**
 * Post a briefing to a recipient's private 1:1 channel (just them + Kit),
 * creating it on first use. Replaces the old DM path: Kit is a Slack assistant
 * app, and proactive DMs to assistant apps land in the History tab instead of
 * notifying. A private channel notifies normally and stays private.
 */
async function postToPersonalChannel(
  slackUserId: string,
  fullName: string | null,
  text: string,
): Promise<string> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN not set')
  const channel = await resolvePersonalBriefingChannel({ slackUserId, fullName, token })
  return postSlack(channel, text)
}

// ─── Cron: scan for upcoming events ───────────────────────────

export const preMeetingScan = inngest.createFunction(
  {
    id: 'pre-meeting-scan',
    name: 'Pre-meeting — Scan upcoming events',
    retries: 1,
    triggers: [{ cron: '*/15 * * * *' }],
  },
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
    const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
    let projectsQuery = sb
      .from('projects')
      .select('id, name, client, project_code, brief_summary, external_ids')
      .eq('status', 'active')
      .limit(50)
    if (workspaceId) {
      projectsQuery = projectsQuery.eq('workspace_id', workspaceId)
    } else {
      console.warn(
        '[pre-meeting-scan] KIT_DEFAULT_WORKSPACE_ID is not set; classifier may see projects from all workspaces',
      )
    }
    const { data: projectRows } = await projectsQuery

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

      let cls: { project_id: string | null; confidence: number; reasoning: string }
      let classifierFailed = false
      try {
        cls = await step.run(`classify-${ev.event_id}`, () =>
          classifyMeeting(ev, activeProjects),
        )
      } catch (err: any) {
        classifierFailed = true
        cls = {
          project_id: null,
          confidence: 0,
          reasoning: `classifier error: ${err?.message || err}`,
        }
      }

      if (classifierFailed) {
        await sb.from('meeting_briefings').upsert(
          {
            event_id: ev.event_id,
            calendar_id: ev.calendar_id,
            meeting_title: ev.summary,
            meeting_start_time: ev.start_time,
            attendees_json: ev.attendees,
            confidence: 0,
            status: 'failed',
            error: cls.reasoning,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'event_id', ignoreDuplicates: false },
        )
        continue
      }

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

    try {
      const artifact = await step.run('compose', () =>
        composeBriefing({ event: calendarEvent, projectId: project_id }),
      )

      // PRIVACY: post the briefing to each R&F attendee's private 1:1 channel
      // (just them + Kit) — the only delivery path by default. This notifies
      // like a normal message (unlike an assistant-app DM, which lands in the
      // History tab). One bad post doesn't fail the rest.
      const notified = await step.run('notify-recipients', async () => {
        const ok: string[] = []
        for (const r of artifact.recipients) {
          try {
            await postToPersonalChannel(r.slack_user_id, r.name, artifact.channelText)
            ok.push(r.slack_user_id)
          } catch (e: any) {
            console.warn(
              `[pre-meeting] briefing to ${r.slack_user_id} failed: ${e?.message || e}`,
            )
          }
        }
        return ok
      })

      // Channel posting is OFF by default — it would expose the briefing to
      // everyone in the channel, not just the people on the call. Opt in only
      // for non-sensitive workflows via BRIEFING_POST_CHANNEL=true.
      const postChannel = process.env.BRIEFING_POST_CHANNEL === 'true'
      const channelTs = postChannel && artifact.projectChannelId
        ? await step.run('post-channel', () =>
            postSlack(artifact.projectChannelId!, artifact.channelText),
          )
        : null

      const sb = createAdminClient()
      await sb
        .from('meeting_briefings')
        .update({
          briefing_md: artifact.channelText,
          slack_channel_id: postChannel ? artifact.projectChannelId : null,
          slack_message_ts: channelTs,
          notified_user_ids: notified,
          status: 'sent',
          updated_at: new Date().toISOString(),
        })
        .eq('event_id', event_id)

      return { sent: true, dmCount: notified.length, channelTs }
    } catch (err: any) {
      // Mark briefing as failed but rethrow so Inngest retries fire.
      const sb = createAdminClient()
      await sb
        .from('meeting_briefings')
        .update({
          status: 'failed',
          error: String(err?.message || err),
          updated_at: new Date().toISOString(),
        })
        .eq('event_id', event_id)
      throw err
    }
  },
)
