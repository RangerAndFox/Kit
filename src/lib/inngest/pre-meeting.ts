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
import { composeBizdevBriefing, hasBizdevAttendee } from '@/lib/agent/bizdev-briefing'
import { deliverBriefingToRecipient, occurrenceSummaryStatus } from '@/lib/agent/briefing-delivery'
import { recordCronSuccess } from '@/lib/health/state'

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

// ─── Cron: scan for upcoming events ───────────────────────────

export const preMeetingScan = inngest.createFunction(
  {
    id: 'pre-meeting-scan',
    name: 'Pre-meeting — Scan upcoming events',
    retries: 1,
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async ({ step, logger }) => {
    await step.run('heartbeat', async () => {
      try { await recordCronSuccess('pre-meeting-scan') } catch {}
      return true
    })
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

    // All the DB reads the loop needs, in ONE memoized step. Inngest replays
    // the whole function body after each step resolves, so un-memoized reads
    // in the loop re-ran O(N²) times — and un-memoized writes made scheduling
    // depend on whichever replay happened to reach them.
    const scanContext = await step.run('load-scan-context', async () => {
      const sb = createAdminClient()

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

      // Bizdev-role staff emails (+ aliases) — gates the bizdev briefing
      // path for meetings that don't classify to any project.
      const { data: bizdevStaffRows } = await sb
        .from('staff')
        .select('email, email_aliases')
        .eq('role', 'bizdev')
        .eq('is_active', true)
      const bizdevEmails: string[] = []
      for (const s of bizdevStaffRows || []) {
        if (s.email) bizdevEmails.push(s.email.trim().toLowerCase())
        for (const alias of s.email_aliases || []) {
          if (alias && alias.trim()) bizdevEmails.push(alias.trim().toLowerCase())
        }
      }

      // Which events are already tracked — one batched query instead of one
      // per event per replay.
      const eventIds = events.map((ev: any) => ev.event_id)
      const { data: existingRows } = eventIds.length
        ? await sb
            .from('meeting_briefings')
            .select('event_id, status')
            .in('event_id', eventIds)
        : { data: [] }
      const alreadyTracked = (existingRows || [])
        .filter((r: any) => r.status !== 'failed')
        .map((r: any) => r.event_id)

      return {
        activeProjects: (projectRows || []).map((p: any) => ({
          id: p.id,
          name: p.name,
          client: p.client,
          project_code: p.project_code,
          brief_summary: p.brief_summary,
          // No staff-by-project mapping yet; team_emails left empty for now.
          team_emails: [],
        })),
        bizdevEmails,
        alreadyTracked,
      }
    })

    const { activeProjects, alreadyTracked } = scanContext
    const bizdevEmails = new Set<string>(scanContext.bizdevEmails)
    const trackedSet = new Set<string>(alreadyTracked)

    // Classify each new event (one memoized step per event), then collect
    // every row + dispatch into plain arrays — the actual writes happen in
    // dedicated steps AFTER the loop so they run exactly once.
    const rows: any[] = []
    const dispatches: { event_id: string; project_id: string | null; event: any; meetingType?: string; sendMs: number }[] = []

    for (const ev of events) {
      if (trackedSet.has(ev.event_id)) continue

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

      const baseRow = {
        event_id: ev.event_id,
        calendar_id: ev.calendar_id,
        meeting_title: ev.summary,
        meeting_start_time: ev.start_time,
        attendees_json: ev.attendees,
        confidence: cls.confidence,
        updated_at: new Date().toISOString(),
      }

      if (classifierFailed) {
        rows.push({ ...baseRow, confidence: 0, status: 'failed', error: cls.reasoning })
        continue
      }

      if (!cls.project_id || cls.confidence < matchThreshold()) {
        // No project match — but if a bizdev staffer is on the invite, this
        // is still worth a briefing (attendee bios instead of project
        // context). Anything else stays a silent skip, as before.
        const isBizdev = hasBizdevAttendee(
          (ev.attendees || []).map((a: any) => a.email),
          bizdevEmails,
        )
        if (!isBizdev) {
          rows.push({ ...baseRow, status: 'skipped', error: cls.reasoning })
          continue
        }
        rows.push({ ...baseRow, status: 'pending', meeting_type: 'bizdev' })
        dispatches.push({
          event_id: ev.event_id,
          project_id: null,
          event: ev,
          meetingType: 'bizdev',
          sendMs: Date.parse(ev.start_time) - lead,
        })
        continue
      }

      rows.push({ ...baseRow, project_id: cls.project_id, status: 'pending' })
      dispatches.push({
        event_id: ev.event_id,
        project_id: cls.project_id,
        event: ev,
        sendMs: Date.parse(ev.start_time) - lead,
      })
    }

    if (rows.length > 0) {
      await step.run('persist-briefings', async () => {
        const sb = createAdminClient()
        const { error } = await sb
          .from('meeting_briefings')
          .upsert(rows, { onConflict: 'event_id', ignoreDuplicates: false })
        if (error) throw new Error(`persist-briefings: ${error.message}`)
        return rows.length
      })
    }

    if (dispatches.length > 0) {
      await step.sendEvent(
        'dispatch-briefings',
        dispatches.map((d) => ({
          name: 'pre-meeting/dispatch',
          data: {
            event_id: d.event_id,
            project_id: d.project_id,
            event: d.event,
            ...(d.meetingType ? { meetingType: d.meetingType } : {}),
          },
          ts: Math.max(now + 1_000, d.sendMs),
        })),
      )
    }

    return { scheduled: dispatches.length, scanned: events.length }
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
    const { event_id, project_id, event: calendarEvent, meetingType } = event.data

    try {
      const artifact = await step.run('compose', () =>
        meetingType === 'bizdev'
          ? composeBizdevBriefing({ event: calendarEvent })
          : composeBriefing({ event: calendarEvent, projectId: project_id }),
      )

      // Canonical occurrence row id — the delivery ledger keys on this, not on
      // event_id, so identity lives in one place (meeting_briefings).
      const meetingBriefingId = await step.run('load-briefing-row', async () => {
        const sb = createAdminClient()
        const { data } = await sb
          .from('meeting_briefings')
          .select('id')
          .eq('event_id', event_id)
          .maybeSingle()
        if (!data?.id) throw new Error(`no meeting_briefings row for event_id ${event_id}`)
        return data.id
      })

      const token = process.env.SLACK_BOT_TOKEN
      if (!token) throw new Error('SLACK_BOT_TOKEN not set')

      // PRIVACY: deliver to each R&F attendee's private 1:1 channel (just them +
      // Kit) — the only delivery path by default. Each recipient is its OWN
      // memoized Inngest step, so a confirmed send is cached and never re-posted
      // when a sibling recipient's step retries (partial-failure safety). Each
      // delivery is atomically claimed in meeting_briefing_deliveries and
      // reconciled via Slack message metadata, so a retry after an ambiguous
      // (timeout) send does not duplicate. This is the authoritative delivery
      // state — notified_user_ids is no longer written.
      const outcomes: any[] = []
      for (const r of artifact.recipients) {
        const outcome = await step.run(`notify-${r.staff_id}`, () =>
          deliverBriefingToRecipient({
            token,
            meetingBriefingId,
            recipient: r,
            text: artifact.channelText,
          }),
        )
        outcomes.push(outcome)
      }
      const delivered = outcomes.filter((o) => o?.status === 'sent').length
      // Occurrence summary is 'sent' ONLY if every recipient reached ledger
      // status 'sent'. A 'locked' recipient (another run holds the claim) leaves
      // it 'pending' — the ledger stays the source of truth and the holder run
      // completes it.
      const summaryStatus = occurrenceSummaryStatus(outcomes, artifact.recipients.length)

      // Channel posting is OFF by default — it would expose the briefing to
      // everyone in the channel, not just the people on the call. Opt in only
      // for non-sensitive workflows via BRIEFING_POST_CHANNEL=true.
      const postChannel = process.env.BRIEFING_POST_CHANNEL === 'true'
      const channelTs = postChannel && artifact.projectChannelId
        ? await step.run('post-channel', () =>
            postSlack(artifact.projectChannelId!, artifact.channelText),
          )
        : null

      // Occurrence-level summary only; per-recipient truth lives in the ledger.
      // A recipient whose delivery threw never reaches here (its step throws →
      // the catch marks the occurrence 'failed'). A recipient that returned
      // 'locked' DOES reach here without throwing, so we derive the summary from
      // the outcomes rather than assuming 'sent'.
      const sb = createAdminClient()
      await sb
        .from('meeting_briefings')
        .update({
          briefing_md: artifact.channelText,
          slack_channel_id: postChannel ? artifact.projectChannelId : null,
          slack_message_ts: channelTs,
          status: summaryStatus,
          updated_at: new Date().toISOString(),
        })
        .eq('event_id', event_id)

      return { sent: summaryStatus === 'sent', status: summaryStatus, dmCount: delivered, channelTs }
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
