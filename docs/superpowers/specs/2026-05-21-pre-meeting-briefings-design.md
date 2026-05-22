# Pre-Meeting Briefings — Design Spec

**Date:** 2026-05-21
**Status:** Approved for implementation (user directed autonomous execution)
**Depends on:** Optionally consumes Plaud transcripts when available; does not block on Plaud.

---

## 1. Problem

Kit's users walk into meetings cold. Latest share links, prior decisions, recent file activity, and open action items live across Frame.io, Dropbox, Harvest, and (eventually) Plaud transcripts. Kit can stitch all of that into a single briefing if it knows two things: (a) a meeting is coming up, and (b) which project it's about.

This spec adds a pre-meeting briefing pipeline: Kit watches Google Calendar for upcoming events, classifies each event to a Kit project, composes a briefing, and DMs participants (and/or posts to the project channel) ~30 minutes before the meeting starts.

**Source of truth for meetings is Google Calendar.** Kit polls Google Calendar to know what's coming up; Plaud (when activated) is only consulted *after* a meeting is identified, as one of several optional content sources for the briefing body — specifically, the most recent past meeting summary for context. Plaud is not in the trigger path and never decides what's a meeting.

## 2. Decisions made autonomously

Because the user delegated this end-to-end, here are the design calls I made without explicit user confirmation. Each is a recommended-option default; if any conflict with the user's intent, they can be revised in a follow-up PR.

| Decision | Choice | Why |
|---|---|---|
| Calendar source | **Google Calendar** | Studio likely uses Google Workspace; Outlook can be a follow-up. |
| Calendar auth | **Service account** (not 3-legged OAuth) | Simpler ops: one Google Cloud service account, calendars shared with its email; no per-user token plumbing. Acceptable trade-off because briefings need read-only access to a known set of project/team calendars. |
| Sync mechanism | **Polling** every 15 minutes via Inngest cron | Push (watch endpoint) requires a verified domain and is awkward in dev. Polling is good enough for a ~10-person studio. |
| Project-mapping | **LLM classifier** (Claude Haiku) reading meeting title + attendees against active project list | Mirrors existing `call-classifier.ts` pattern. Confidence threshold rejects ambiguous matches (no spammy bad briefings). |
| Timing | **30 minutes before** meeting start | Window long enough to read on phone before joining. Configurable via env. |
| Audience | **Channel post + producer DM** | Channel for transparency; DM the project's producer/CD for any private context. Externals (non-Slack users) never get DM'd. |
| Briefing content | Project header, meeting context, recent Frame.io share, recent Dropbox activity, last Plaud transcript summary if available, open `kit_actions` for the project | Surfaces high-signal artifacts an attendee actually wants to see. |
| Activation gating | `GOOGLE_CALENDAR_INGEST_ENABLED=false` default | Skeleton pattern proven on Plaud. Ships safely without creds; operator flips when ready. |
| Branch strategy | New `feature/pre-meeting-briefings` from `main`, separate PR | Independent shipping unit; rebase on top of Plaud once that lands. |

## 3. Goals

1. Add a Google Calendar integration module (`src/lib/integrations/google-calendar.ts`) with service-account auth + flag-gated calendar event fetch.
2. Stand up an Inngest cron (`pre-meeting-briefings/scan`) that runs every 15 minutes, looks for events starting in the next 30-60 minutes, matches each to a project, composes a briefing, and dispatches send events.
3. Add a `meeting_briefings` Supabase table for idempotent send-tracking.
4. Add a project-meeting LLM matcher mirroring `call-classifier.ts`.
5. Compose a briefing markdown body that sources content from existing Kit tables (`projects`, `kit_actions`, `call_transcripts`, `project_documents` for RAG) and posts via Slack `chat.postMessage` to the project channel + DMs the producer.
6. Surface Plaud signal: when `call_transcripts` exists for the project (`source='plaud'`, `ingest_status='ingested'`), include the most recent summary in the briefing.
7. Register the new integration in `INTEGRATION_REGISTRY` and link from settings.

## 4. Non-Goals

- 3-legged Google OAuth (deferred — service account covers all current use cases).
- Outlook / Microsoft 365 calendar integration (follow-up spec).
- Google Calendar push notifications (deferred — polling is sufficient at this scale).
- Personalized briefings per attendee (everyone in the channel sees the same briefing; producer DM adds private context only).
- Automatic meeting recording or note-taking (Plaud's job; this spec only *consumes* Plaud output).
- AI-generated reminders for things not in Kit (e.g. "you should bring up X"). Future work.

## 5. Architecture

```
Every 15m (Inngest cron: pre-meeting/scan)
  │
  │  if (!GOOGLE_CALENDAR_INGEST_ENABLED) → log + return early
  ▼
fetchUpcomingEvents()
  → list events from now to now+60m across configured calendars
  → returns [{ event_id, summary, attendees, start_time, calendar_id }]
  ▼
for each event:
  ▼
  matchProjectForMeeting(event, activeProjects)
    → Claude Haiku: given title + attendees + active project list,
      return { project_id, confidence } or null
    → if confidence < 0.5 → skip
  ▼
  if (meeting_briefings already has row for this event_id) → skip
  ▼
  inngest.send('pre-meeting/dispatch', { event_id, project_id, send_at: start_time - 30m })
  ▼
... at send_at ...
  ▼
plaud-briefing-dispatch fn (delayed step.sleep)
  → composeBriefing(project_id, event) → markdown blob
  → post to project channel
  → DM producer with private context section
  → upsert meeting_briefings row { status: 'sent', sent_at }
```

### Idempotency

- `meeting_briefings.event_id` is unique; `upsert + ignoreDuplicates: true` on insert prevents double-dispatch.
- Inngest event names carry `event_id` for dedup.
- A briefing that was already sent will not be re-sent if the cron re-encounters the same event (the scan checks for an existing `sent` or `pending` row first).

### Failure modes

| Failure | Behavior |
|---|---|
| Google API down | Inngest cron throws; Inngest retries on next run. No partial state. |
| Single project match fails (LLM error) | That event is skipped; cron continues; row logged with `status='failed'`. |
| Slack post fails | Inngest retries; briefing markdown stored in DB so retries don't recompute LLM context. |
| Flag off | Cron runs but returns early; no API calls. |
| Service account JSON missing | `getGoogleAuth()` throws at first call; cron run fails loudly. |

## 6. Components

### Added

- `supabase/migrations/017_pre_meeting_briefings.sql` — `meeting_briefings` table + indexes.
- `src/lib/integrations/google-calendar.ts` — service-account auth + `fetchUpcomingEvents` (flag-gated).
- `src/lib/agent/meeting-classifier.ts` — Claude Haiku classifier matching events to projects.
- `src/lib/agent/briefing-composer.ts` — composes the markdown briefing from project + event + Plaud + Frame.io + Dropbox + kit_actions context.
- `src/lib/inngest/pre-meeting.ts` — two Inngest functions:
  - `preMeetingScan` (cron, every 15m)
  - `preMeetingDispatch` (event-triggered, fires at `send_at`)
- `scripts/test-meeting-classifier.ts` — smoke test for the classifier with fixture events (works offline; no Google API calls).

### Modified

- `src/lib/integrations/registry.ts` — Google Calendar entry status `'available'` → already there; flip to `'available'` if not, and add documentationUrl.
- `src/app/api/inngest/route.ts` — register the two new Inngest functions.

### Untouched

- Slack send paths — uses existing `chat.postMessage` patterns.
- Existing project/action queries — uses existing Supabase admin client.

## 7. Data model

`meeting_briefings`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `event_id` | text unique | Google Calendar event id |
| `calendar_id` | text | source calendar |
| `project_id` | uuid | references projects(id); nullable if matcher was uncertain |
| `meeting_title` | text | event summary |
| `meeting_start_time` | timestamptz | event start |
| `attendees_json` | jsonb | array of `{email, name?, response_status?}` |
| `briefing_md` | text | composed markdown, populated when ready |
| `slack_channel_id` | text | project channel where briefing posted |
| `slack_message_ts` | text | message ts of the channel post |
| `producer_dm_ts` | text | DM ts to producer (if any) |
| `confidence` | numeric | classifier confidence 0..1 |
| `status` | text | `'pending' | 'sent' | 'failed' | 'skipped'`; CHECK constraint |
| `error` | text | populated when status='failed' |
| `created_at` | timestamptz default now() | |
| `updated_at` | timestamptz default now() | |

Indexes: unique on `event_id`, btree on `(status, meeting_start_time)`.

## 8. Configuration

| Env var | Required when | Purpose |
|---|---|---|
| `GOOGLE_CALENDAR_INGEST_ENABLED` | always (defaults `false`) | Master switch. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `INGEST_ENABLED=true` | Service account credentials JSON (base64-encoded recommended). |
| `GOOGLE_CALENDAR_IDS` | `INGEST_ENABLED=true` | Comma-separated list of calendar IDs the service account has access to. |
| `BRIEFING_LEAD_TIME_MINUTES` | optional (default `30`) | How far in advance to send the briefing. |
| `BRIEFING_MATCH_THRESHOLD` | optional (default `0.5`) | LLM confidence threshold; below this, event is skipped. |

## 9. Testing

- Unit: `scripts/test-meeting-classifier.ts` — uses fixture events + a mocked Anthropic call (or skipped if `ANTHROPIC_API_KEY` not set in dev) to confirm match-by-attendees + match-by-title work.
- Integration (deferred until creds exist):
  1. Configure service account, share a test calendar.
  2. Create test event 35 minutes in the future with a known project attendee.
  3. Wait for cron run; confirm `meeting_briefings` row appears with `status='pending'`.
  4. Wait for `send_at`; confirm briefing posted to channel.

## 10. Open Questions / Risks

- **Service account vs OAuth choice.** If the studio actually uses 3-legged OAuth (e.g. wants per-user calendar access), the service-account approach won't fit. Mitigation: the auth helper is encapsulated in `google-calendar.ts`; swapping auth methods later is a single-file change.
- **LLM cost.** Polling every 15m and classifying each upcoming event burns Anthropic tokens. Mitigation: cache classifications keyed by `event_id` so re-runs don't re-classify.
- **Calendar ID discovery.** Operator must know each calendar's id (looks like `team@studio.com` or a UUID). The settings page should later show the configured calendars; today they're env-only.
- **Time-zone correctness.** Service account events have timezone-aware timestamps; comparisons must use UTC consistently. The cron uses `new Date()` and ISO timestamps end-to-end.
- **Plaud signal absence today.** Until Plaud is activated, the briefing's "last meeting summary" section will be empty. That's fine; the rest of the briefing is still valuable.

---

**Next step:** implementation plan at `docs/superpowers/plans/2026-05-21-pre-meeting-briefings.md`.
