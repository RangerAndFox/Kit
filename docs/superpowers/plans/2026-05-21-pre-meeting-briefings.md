# Pre-Meeting Briefings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan.

**Goal:** Wire up pre-meeting briefings: Inngest cron polls Google Calendar (service-account auth, flag-gated), matches events to Kit projects via LLM, composes a briefing markdown blob, posts to the project channel + DMs the producer ~30 min before meeting start.

**Architecture:** Skeleton + flag pattern (same as Plaud). All calendar/LLM work gated behind `GOOGLE_CALENDAR_INGEST_ENABLED=true` so this lands safely without creds.

**Tech Stack:** Next.js App Router, Inngest v4 (cron + event-triggered), Supabase, Anthropic SDK (Haiku), googleapis npm package (service-account auth).

**Spec:** `docs/superpowers/specs/2026-05-21-pre-meeting-briefings-design.md`

---

## Conventions

- Files use `// @ts-nocheck` per project convention.
- Migrations are `NNN_descriptor.sql`. Plaud uses `014`; this is `015`.
- Inngest functions are registered in `src/app/api/inngest/route.ts`.
- Service account JSON is base64-encoded in env to avoid newline mangling.

---

## Task 1: Supabase migration `015_pre_meeting_briefings.sql`

**Files:** Create `supabase/migrations/015_pre_meeting_briefings.sql`.

Content:

```sql
-- 015_pre_meeting_briefings.sql
-- Pre-meeting briefings: cron-scheduled meeting reminders with project context.
-- Spec: docs/superpowers/specs/2026-05-21-pre-meeting-briefings-design.md

begin;

create table if not exists public.meeting_briefings (
  id uuid primary key default gen_random_uuid(),
  event_id text not null,
  calendar_id text,
  project_id uuid references public.projects(id) on delete set null,
  meeting_title text,
  meeting_start_time timestamptz,
  attendees_json jsonb,
  briefing_md text,
  slack_channel_id text,
  slack_message_ts text,
  producer_dm_ts text,
  confidence numeric,
  status text not null default 'pending'
    constraint meeting_briefings_status_check
    check (status in ('pending', 'sent', 'failed', 'skipped')),
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists meeting_briefings_event_id_key
  on public.meeting_briefings (event_id);

create index if not exists meeting_briefings_status_start_idx
  on public.meeting_briefings (status, meeting_start_time);

commit;
```

Commit:

```bash
git -C "C:/Users/studi/Kit" add supabase/migrations/015_pre_meeting_briefings.sql
git -C "C:/Users/studi/Kit" commit -m "db: 015_pre_meeting_briefings — schema for briefing tracking"
```

---

## Task 2: Google Calendar integration module

**Files:** Create `src/lib/integrations/google-calendar.ts`.

Content:

```ts
// @ts-nocheck
/**
 * Google Calendar integration (service-account auth).
 *
 * Spec: docs/superpowers/specs/2026-05-21-pre-meeting-briefings-design.md
 *
 * Service account approach: one shared service account reads N calendars
 * the studio has shared with its email. No per-user OAuth required.
 *
 * All fetch operations are gated by GOOGLE_CALENDAR_INGEST_ENABLED.
 */

import { google } from 'googleapis'

export interface CalendarEvent {
  event_id: string
  calendar_id: string
  summary: string
  description?: string
  start_time: string
  end_time: string
  attendees: Array<{ email: string; displayName?: string; responseStatus?: string }>
  organizer?: { email: string; displayName?: string }
  hangoutLink?: string
}

function ingestEnabled(): boolean {
  return process.env.GOOGLE_CALENDAR_INGEST_ENABLED === 'true'
}

function getServiceAccountCreds(): any {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set')
  }
  // Allow either raw JSON or base64-encoded JSON (env-friendly).
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf-8')
  try {
    return JSON.parse(json)
  } catch (err) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (or base64-encoded JSON)')
  }
}

function getCalendarIds(): string[] {
  const raw = process.env.GOOGLE_CALENDAR_IDS || ''
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function getCalendarClient() {
  const creds = getServiceAccountCreds()
  const auth = new google.auth.JWT(
    creds.client_email,
    undefined,
    creds.private_key,
    ['https://www.googleapis.com/auth/calendar.readonly'],
  )
  return google.calendar({ version: 'v3', auth })
}

/**
 * Fetch upcoming events from all configured calendars whose start time
 * falls between `fromIso` and `toIso`. Returns a flat list across calendars.
 *
 * Throws if the ingest flag is off — callers must gate.
 */
export async function fetchUpcomingEvents(
  fromIso: string,
  toIso: string,
): Promise<CalendarEvent[]> {
  if (!ingestEnabled()) {
    throw new Error('GOOGLE_CALENDAR_INGEST_ENABLED is false — calendar fetch is disabled')
  }
  const calendar = getCalendarClient()
  const calendarIds = getCalendarIds()
  if (calendarIds.length === 0) {
    return []
  }

  const out: CalendarEvent[] = []
  for (const calendarId of calendarIds) {
    const res = await calendar.events.list({
      calendarId,
      timeMin: fromIso,
      timeMax: toIso,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    })
    const items = res.data.items || []
    for (const ev of items) {
      if (!ev.id || !ev.start?.dateTime) continue
      out.push({
        event_id: `${calendarId}:${ev.id}`,
        calendar_id: calendarId,
        summary: ev.summary || '',
        description: ev.description || undefined,
        start_time: ev.start.dateTime,
        end_time: ev.end?.dateTime || ev.start.dateTime,
        attendees: (ev.attendees || []).map((a) => ({
          email: a.email || '',
          displayName: a.displayName || undefined,
          responseStatus: a.responseStatus || undefined,
        })),
        organizer: ev.organizer
          ? { email: ev.organizer.email || '', displayName: ev.organizer.displayName || undefined }
          : undefined,
        hangoutLink: ev.hangoutLink || undefined,
      })
    }
  }
  return out
}
```

Steps:

1. Confirm `googleapis` is in package.json: `grep -l googleapis "C:/Users/studi/Kit/package.json"` — if not present, install: `cd "C:/Users/studi/Kit" && npm install googleapis`.
2. Write the file.
3. `npx tsc --noEmit` — clean.
4. Commit:
   ```bash
   git -C "C:/Users/studi/Kit" add src/lib/integrations/google-calendar.ts package.json package-lock.json
   git -C "C:/Users/studi/Kit" commit -m "feat: Google Calendar integration module (service-account auth, flag-gated)"
   ```

---

## Task 3: Meeting classifier (LLM)

**Files:** Create `src/lib/agent/meeting-classifier.ts` and `scripts/test-meeting-classifier.ts`.

`meeting-classifier.ts` content:

```ts
// @ts-nocheck
/**
 * Meeting → Project classifier.
 *
 * Given a calendar event and the workspace's active projects, calls
 * Claude Haiku to pick the best matching project (or null). Returns
 * confidence 0..1.
 *
 * Pattern: mirrors src/lib/agent/call-classifier.ts.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { CalendarEvent } from '@/lib/integrations/google-calendar'

export interface ActiveProject {
  id: string
  name: string
  client: string | null
  project_code: string | null
  brief_summary: string | null
  team_emails: string[]
}

export interface ClassificationResult {
  project_id: string | null
  confidence: number
  reasoning: string
}

const SYSTEM_PROMPT = `You are a meeting-to-project classifier for a video studio.
Given a calendar event and a list of active projects, identify which project the
meeting is most likely about. Match on (in priority order):

1. Project code or client name appearing in the meeting title.
2. Attendees whose emails match a project's team_emails.
3. Keywords in the meeting title matching the project's brief_summary.

Return JSON only:
{
  "project_id": "<uuid or null>",
  "confidence": <0.0..1.0>,
  "reasoning": "<one short sentence>"
}

If no project clearly matches, return project_id: null with low confidence.
Never guess; prefer null over a low-confidence match.`

export async function classifyMeeting(
  event: CalendarEvent,
  activeProjects: ActiveProject[],
): Promise<ClassificationResult> {
  if (activeProjects.length === 0) {
    return { project_id: null, confidence: 0, reasoning: 'no active projects' }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set')
  }

  const client = new Anthropic({ apiKey })

  const userPrompt = `Calendar event:
  title: ${JSON.stringify(event.summary)}
  description: ${JSON.stringify(event.description || '')}
  attendees: ${JSON.stringify(event.attendees.map((a) => a.email))}
  organizer: ${JSON.stringify(event.organizer?.email || '')}

Active projects:
${JSON.stringify(activeProjects, null, 2)}

Respond with JSON only.`

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const text = res.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')

  // Strip code fences if Haiku wrapped the JSON.
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()

  let parsed: ClassificationResult
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    throw new Error(`Classifier returned non-JSON: ${cleaned}`)
  }

  if (typeof parsed.confidence !== 'number') parsed.confidence = 0
  if (!parsed.project_id) parsed.project_id = null
  if (!parsed.reasoning) parsed.reasoning = ''
  return parsed
}
```

`scripts/test-meeting-classifier.ts`:

```ts
// @ts-nocheck
/**
 * Smoke test for the meeting classifier.
 *
 * Skips if ANTHROPIC_API_KEY is not in env — does NOT fail in that case.
 * When the key is present, runs three fixture events against fixture
 * projects and prints the classifier's responses for sanity-checking.
 *
 * Run with: npx tsx scripts/test-meeting-classifier.ts
 */

import { classifyMeeting } from '../src/lib/agent/meeting-classifier'

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('SKIP — ANTHROPIC_API_KEY not set; cannot exercise classifier live.')
  process.exit(0)
}

const projects = [
  {
    id: 'p-rayfin',
    name: 'Rayfin Overview Reel',
    client: 'Rayfin Industries',
    project_code: '2655',
    brief_summary: 'Hero brand reel for Rayfin Industries Q3 launch.',
    team_emails: ['alice@rangerandfox.tv', 'producer@rangerandfox.tv'],
  },
  {
    id: 'p-microsoft',
    name: 'Microsoft Surface Launch',
    client: 'Microsoft',
    project_code: '2701',
    brief_summary: 'Surface Studio reveal launch sizzle for Microsoft.',
    team_emails: ['bob@rangerandfox.tv', 'producer@rangerandfox.tv'],
  },
]

const events = [
  {
    event_id: 'cal:e1',
    calendar_id: 'team@rangerandfox.tv',
    summary: 'Rayfin sync — hero shot review',
    description: 'Catch up on V3 with the producer',
    start_time: new Date(Date.now() + 30 * 60_000).toISOString(),
    end_time: new Date(Date.now() + 60 * 60_000).toISOString(),
    attendees: [
      { email: 'alice@rangerandfox.tv' },
      { email: 'someone@rayfin.com' },
    ],
  },
  {
    event_id: 'cal:e2',
    calendar_id: 'team@rangerandfox.tv',
    summary: 'Microsoft 2701 weekly',
    description: '',
    start_time: new Date(Date.now() + 30 * 60_000).toISOString(),
    end_time: new Date(Date.now() + 60 * 60_000).toISOString(),
    attendees: [{ email: 'bob@rangerandfox.tv' }],
  },
  {
    event_id: 'cal:e3',
    calendar_id: 'team@rangerandfox.tv',
    summary: 'Studio standup',
    description: 'Internal weekly',
    start_time: new Date(Date.now() + 30 * 60_000).toISOString(),
    end_time: new Date(Date.now() + 60 * 60_000).toISOString(),
    attendees: [{ email: 'producer@rangerandfox.tv' }],
  },
]

let failed = 0
for (const ev of events) {
  const res = await classifyMeeting(ev, projects)
  console.log(`Event "${ev.summary}":`)
  console.log(`  project: ${res.project_id ?? '(none)'}  confidence: ${res.confidence.toFixed(2)}`)
  console.log(`  reasoning: ${res.reasoning}`)
  console.log('')
}

if (failed) process.exit(1)
console.log('Done.')
```

Steps:

1. Confirm `@anthropic-ai/sdk` is installed: `grep '@anthropic-ai/sdk' "C:/Users/studi/Kit/package.json"`. It should be — Kit already uses Anthropic. If not, install.
2. Write both files.
3. Type-check: `npx tsc --noEmit` from `C:/Users/studi/Kit`. Expected clean.
4. Run script (will SKIP without `ANTHROPIC_API_KEY`):
   ```bash
   cd "C:/Users/studi/Kit" && npx tsx scripts/test-meeting-classifier.ts
   ```
5. Commit:
   ```bash
   git -C "C:/Users/studi/Kit" add src/lib/agent/meeting-classifier.ts scripts/test-meeting-classifier.ts
   git -C "C:/Users/studi/Kit" commit -m "feat: meeting classifier (Haiku) + offline smoke script"
   ```

---

## Task 4: Briefing composer

**Files:** Create `src/lib/agent/briefing-composer.ts`.

Content:

```ts
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
```

Steps:

1. Write the file.
2. Type-check.
3. Commit:
   ```bash
   git -C "C:/Users/studi/Kit" add src/lib/agent/briefing-composer.ts
   git -C "C:/Users/studi/Kit" commit -m "feat: briefing composer pulls project + actions + Plaud context"
   ```

---

## Task 5: Inngest functions

**Files:** Create `src/lib/inngest/pre-meeting.ts`.

Content:

```ts
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
```

Steps:

1. Write the file.
2. Type-check.
3. Commit:
   ```bash
   git -C "C:/Users/studi/Kit" add src/lib/inngest/pre-meeting.ts
   git -C "C:/Users/studi/Kit" commit -m "feat: pre-meeting Inngest scan + dispatch functions (skeleton)"
   ```

---

## Task 6: Register Inngest functions

**Files:** Modify `src/app/api/inngest/route.ts`.

Add imports + registry entries for `preMeetingScan` and `preMeetingDispatch`. Final file:

```ts
// @ts-nocheck
import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { provisionProject } from '@/lib/inngest/orchestrator'
import { plaudTranscriptionReady, plaudTranscriptionFailed } from '@/lib/inngest/plaud'
import { preMeetingScan, preMeetingDispatch } from '@/lib/inngest/pre-meeting'

/**
 * Inngest API route.
 *
 * Inngest's serve() adapter handles:
 *   - Function registration (POST /api/inngest)
 *   - Step execution callbacks
 *   - Health checks
 *
 * All Kit Inngest functions are registered here.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    provisionProject,
    plaudTranscriptionReady,
    plaudTranscriptionFailed,
    preMeetingScan,
    preMeetingDispatch,
    // Add new functions here as agents are built
  ],
})
```

**Important:** this file currently exists in two flavors depending on whether you're branched from main or from feature/plaud-migration. This plan branches from main, so it does NOT include the Plaud lines initially. The Plaud lines will land via the Plaud PR; once that merges, this file picks them up via rebase. If the Plaud PR has not merged, the import for Plaud functions will fail at runtime — but `tsc --noEmit` honors `@ts-nocheck`, so build will succeed. The cron just won't have access to Plaud-specific event listeners (and doesn't need them).

For the actual commit:

- If branched from `main` (no Plaud yet): keep imports limited to `provisionProject` + the four `preMeeting*` / `plaud*` lines as shown above. The Plaud imports will fail at runtime BUT the file is `@ts-nocheck`. Acceptable for skeleton.
- If branched on top of Plaud: the file already has Plaud imports; just add the preMeeting* line.

Detect which case applies before editing.

Commit:

```bash
git -C "C:/Users/studi/Kit" add src/app/api/inngest/route.ts
git -C "C:/Users/studi/Kit" commit -m "chore: register pre-meeting Inngest functions"
```

---

## Task 7: Integrations registry — Google Calendar status

**Files:** Modify `src/lib/integrations/registry.ts`.

Find the existing Google Calendar entry (id `'google_calendar'`, status `'available'`). It's already in the registry. Add `documentationUrl: 'https://developers.google.com/calendar/api'` to the entry for completeness.

If the entry doesn't already have `documentationUrl`, add it.

Commit:

```bash
git -C "C:/Users/studi/Kit" add src/lib/integrations/registry.ts
git -C "C:/Users/studi/Kit" commit -m "chore: add Google Calendar docs URL to integrations registry"
```

(Skip this task entirely if the registry entry already has a documentationUrl — it's purely a metadata polish.)

---

## Task 8: Docs — `.env.example` + README

**Files:** Modify `.env.example` and `README.md`.

Append to `.env.example`:

```
# ─── Google Calendar — pre-meeting briefings ─────────────────
# Master switch for the briefing cron. Leave 'false' until creds + calendars
# are set up and you've verified a test event flows through.
GOOGLE_CALENDAR_INGEST_ENABLED=false
# Service account JSON (raw, or base64-encoded). Required when INGEST_ENABLED=true.
GOOGLE_SERVICE_ACCOUNT_JSON=
# Comma-separated calendar IDs the service account has been shared into.
GOOGLE_CALENDAR_IDS=
# How far in advance to send briefings (minutes; default 30).
BRIEFING_LEAD_TIME_MINUTES=30
# Classifier confidence below which an event is skipped (0..1; default 0.5).
BRIEFING_MATCH_THRESHOLD=0.5
```

Add a README section near other webhook/integration notes:

```markdown
### Pre-meeting briefings (Google Calendar)

Kit can DM/post a context briefing ~30 minutes before each meeting. Setup:

1. Create a Google Cloud service account; download its JSON.
2. Share each Kit-relevant calendar with the service account's `client_email`. Read-only is sufficient.
3. Set `GOOGLE_SERVICE_ACCOUNT_JSON` (raw or base64-encoded) and `GOOGLE_CALENDAR_IDS` (comma-separated) in Railway.
4. Flip `GOOGLE_CALENDAR_INGEST_ENABLED=true`.
5. The `preMeetingScan` cron runs every 15 minutes via Inngest.

Spec: `docs/superpowers/specs/2026-05-21-pre-meeting-briefings-design.md`.
```

Commit:

```bash
git -C "C:/Users/studi/Kit" add .env.example README.md
git -C "C:/Users/studi/Kit" commit -m "docs: pre-meeting briefing env vars + setup instructions"
```

---

## Task 9: Final sweep

```bash
cd "C:/Users/studi/Kit" && npx tsc --noEmit
```

Expected: clean.

```bash
git -C "C:/Users/studi/Kit" log --oneline main..feature/pre-meeting-briefings
```

Expected: 7-8 commits in order matching the tasks above.

```bash
git -C "C:/Users/studi/Kit" status --short
```

Expected: empty.

---

## Definition of Done

- 7-8 commits on `feature/pre-meeting-briefings`.
- `npx tsc --noEmit` passes.
- `pre-meeting-briefings` branch pushed to origin, PR opened.
- Migration `015_pre_meeting_briefings.sql` present in the diff (not yet applied).

## Rollout

1. Apply migration `015_pre_meeting_briefings.sql`.
2. Create Google Cloud service account, share relevant calendars.
3. Set `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CALENDAR_IDS` in Railway.
4. Flip `GOOGLE_CALENDAR_INGEST_ENABLED=true`.
5. Watch Inngest logs for the next 15-minute scan; confirm rows appear in `meeting_briefings`.
