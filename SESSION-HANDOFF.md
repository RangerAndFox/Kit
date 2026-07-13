# Kit — Session Handoff (current)

Pick-up notes reflecting the current state of Kit. Supersedes the earlier
time-tracking-only handoff (that work is all done + merged). For the AE render
farm specifically, see `AE-RENDER-FARM-HANDOFF.md`.

Work is on branch `claude/laughing-ride-htu0dx`, PR'd → squash-merged to `main`
(deploys: Railway = bolt, Vercel = Inngest). Supabase project `ozsxrcgrezpffnpwlrnq`.

---

## 2026-07-13 session — outages fixed + health monitor

- **Dropbox was dead on Vercel (~3 months)** — the delivery/specs crons 401'd on
  `invalid_access_token` because Vercel had only a stale static `DROPBOX_ACCESS_TOKEN`
  and none of the refresh trio. Fixed: added `DROPBOX_APP_KEY/_APP_SECRET/_REFRESH_TOKEN`
  (copied from Railway), removed the static token. Live-verified green.
- **Frame.io was down on Vercel** — `FRAMEIO_ADOBE_REFRESH_TOKEN` was missing (only
  CLIENT_ID/SECRET present since May). The new health monitor caught it on first run;
  adding the token fixed it. Green.
- **Date-awareness fix (PR #101)** — the orchestrator + specialists ran with no notion
  of "now", so relative dates ("last Thursday") made Kit ask the user the date. Now a
  current-date system block is injected every LLM turn; ad-hoc hours pre-filter also
  matches minutes. Live-verified.
- **Ponytail cleanup finished (PR #101)** — deleted the two dead files the earlier
  audit batches missed (`new_project_service_module_code/`, `layout-shell.tsx`, −3,071
  lines). nda tests made Windows-safe.
- **Health monitor (PR #102) — LIVE.** `/status` page + `/api/status` (200/503) +
  `health-watchdog` cron (every 10m) posting to `KIT_HEALTH_CHANNEL_ID` only on a
  down/recover flip. Probes Dropbox/Frame.io/Harvest/Supabase/Google + cron freshness
  (delivery scans, transcript scan, pre-meeting scan heartbeat on each fire).
  Migration 052 applied. Field guide links to `/status`.
- **Briefings — calendar access now working.** Root cause was never the sharing alone:
  `GOOGLE_CALENDAR_INGEST_ENABLED` was off, and `GOOGLE_CALENDAR_IDS` pointed at personal
  emails (404) instead of the shared studio calendars (General, Events, …). Fixed: flag
  on, IDs swapped to the studio calendars, calendars shared with the service account
  `kit-373@rf-kit-500717.iam.gserviceaccount.com`. `pre-meeting-scan` completes clean,
  `fetch-events` succeeds, 0 events only when none are imminent. Full classify→DM path
  not yet seen fire (needs a real meeting within ~30 min, or the smoke test below).

### New issues surfaced today (not yet fixed)
- **`/Delivery-Queue` 409 `path/not_found`** — Dropbox auth is fixed, but the delivery
  scan now errors because the queue folder path doesn't resolve. Likely the folder
  doesn't exist at the Dropbox root, or the watcher's path is off. Low urgency.
- **Preview deployments receiving cron traffic** — Inngest is firing crons at `main`
  AND preview branch deployments (`kit-agent-packaging`, `laughing-ride`), causing
  duplicate/erroring runs. The Inngest↔Vercel sync should target production only.

### Open / optional
- **Briefings smoke test** — drop a throwaway event on General ~25 min out with an R&F
  attendee to watch a real briefing fire (`scanned: 1, scheduled: 1` → DM).
- **`GOOGLE_CALENDAR_IDS`** currently the studio calendars only — widen if meetings live
  elsewhere. Briefing recipients still require the R&F person to be an **attendee** on
  the event (matched to `staff` by email).

---

## What's LIVE and verified

- **Time tracking** — daily per-person-timezone check-ins, multi-day replies,
  ad-hoc logging, missing-time monitor. 6/8 active staff mapped + on check-ins
  (2 intentionally off). `/kit backfill-time` and `/kit sync-staff` exist.
- **Meeting transcripts** — Google Drive ingest (Zapier drops Plaud transcripts;
  Kit ingests every 15 min). ~25 flowing. The dead Plaud-API path was removed.
- **Conversational Q&A** — @mention/DM orchestrator; project/codename resolution
  (keyword → project, incl. Harvest-only internal projects); Frame.io links;
  in-thread replies stay in-thread.
- **Provisioning** — `/kit newproject` fans out to Slack/Dropbox/Harvest/Frame.io.
- **Caption QC** — SRTs in the accessibility folder auto-generate TTML/VTT/TXT
  **and** get a proofread report (✅/❌) in the project channel.
- **Weekly timesheet meme** — Friday 9am, @channel, rotating templates (imgflip).
- **Founder DM access** — Steve + Jared have `team_members` rows (`role='admin'`)
  → admin tier → full knowledge base (budgets, all projects) in their DMs.
- Both `src` and `bolt` typecheck clean; bolt suite green.

## SET UP but not yet exercised

- **AE render farm** — runs on the studio Deadline farm (`RENDER_BACKEND=deadline`;
  `kit-deadline-relay` on AC-Slater; group `kit_ae`; KitAfterEffects plugin).
  `render_jobs` is still empty — no live render yet. Test procedure + the
  unverified bits (OM settings shape in AE 2026, Deadline status parsing) are in
  `AE-RENDER-FARM-HANDOFF.md`.

## NOT yet installed (blocks these)

- **`kit-render-worker`** isn't installed anywhere. Blocks the delivery/transcode
  pipeline AND the AE "Add delivery specs" follow-up transcodes. Install on
  AC-Slater (`install.ps1`, `DROPBOX_SYNC_PATH` = local `/production` root).
  (AE *rendering* works via Deadline without it; *transcodes* need it.)

## Config flags to flip when wanted

- **Brain scavenger** → `KIT_BRAIN_SCAVENGER_ENABLED=true` on **both** Railway
  (dispatch) and Vercel (scan).
- **Timesheet meme images** → `IMGFLIP_USERNAME`/`PASSWORD` + `KIT_TEAM_CHANNEL_ID`
  (all set — meme is live).

## Admin commands

`/kit sync-staff` · `/kit sync-projects` (Harvest→Supabase reconcile, preview →
`run`) · `/kit backfill-time` · `/kit meme` · `/kit render` (+ `status`).

## Open decisions / follow-ups

- **`creative_director` role** maps to `artist` tier (no budget visibility) —
  probably should be `producer` for a studio. Awaiting a call.
- **Inngest/Vercel** — confirm the cloud-side crons (briefings, delivery scans,
  brain jobs, transcript ingest, studio-knowledge) are registered + firing; if
  the Inngest↔Vercel sync ever breaks, they silently stop.
- Data cleanup done this session: 232 projects (test junk + dupes removed),
  transcript flow healthy.

## Notable this-session history

Audit cleanup (~5,300 lines + 7 deps removed, root tsc 6→0 via regenerated
Supabase types), multi-day check-ins, threading fix, project-codename/keyword
resolution + `/kit sync-projects`, caption QC, timesheet meme, founder DM access
hardening (`role='admin'` → admin tier), dead Plaud-API removal, and the
project-table cleanup. All merged (PRs up through #99).
