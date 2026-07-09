# Kit — Session Handoff (2026-07-09)

Pick-up notes for continuing this work in another session. Everything below
was built/merged this session on branch `claude/laughing-ride-htu0dx`
(each PR merged to `main`, branch reset onto `main` after each).

---

## TL;DR — what to do next

1. **Deploy settle**: Railway (bolt) + Vercel (Inngest) auto-deploy from `main`.
   Latest merge is PR #81. Give ~2 min after any merge.
2. **Run the time backfill** (admin, in Slack):
   - `/kit backfill-time` → preview (writes nothing)
   - `/kit backfill-time run` → logs confirmable back-times to Harvest, reports entry #s
3. **Decisions still open** (see "Open decisions" below):
   - Brown's **7/6**: Ignite (2609) vs Meera (2611)? Backfill currently logs **Ignite**.
   - Ted's **internal** time (7/6, 7/7): create an "Internal" Harvest project, then re-run backfill.
4. **Clear the slate**: after backfill + internal fix, ask to wipe remaining stale
   `parsed`/`sent` check-in rows so everyone starts clean.

---

## Time-tracking (Harvest) — current state

**The full loop works now, verified end-to-end.** Steve's 7/8 check-in logged for
real: Harvest entries **#2965170441** (1h Magic Quadrant) + **#2965170442**
(0.5h Azure Gov).

### What was broken and fixed this session
- **Silent confirm failure (root cause)**: the confirm handler claims the row with
  `status='logging'`, but that value was never in the `daily_hours_checkins` status
  CHECK constraint. Postgres rejected the claim; code mistook it for a lost race and
  returned silently. **Every** confirm (button + typed yes) died there. Fixed:
  migration `048_checkin_logging_status.sql` (applied to prod). Claim errors are now
  loud (logged + user-visible).
- **Wrong-day entries**: ad-hoc logging defaulted `spent_date` to UTC "today" → at
  5pm PT that's already tomorrow. Fixed: `src/lib/time/studio-date.ts` +
  per-person timezone (below).
- **Ad-hoc misattribution**: `logTime` never passed `user_id` → entries booked to the
  API-token owner. Fixed: logger's `harvest_user_id` now rides along (`staffProfile`).
- **Fuzzy project matching**: `searchProjects` required the whole query as a literal
  substring, so "Crunchy roll", "2611_MSFT_AI-in-Meetings", "2611" failed. Rewritten
  in `src/lib/harvest/search.ts` (scores code/client/name, separator-insensitive,
  single dominant winner auto-selects else candidates).
- **Assignment friction**: Harvest rejects entries for users not assigned to a project.
  Now: provisioning assigns whole team; `/kit sync-staff` backfills all active projects;
  `createTimeEntry` self-heals (assign + retry) on the not-assigned error.
- **Confirmation is verifiable**: success message cites the Harvest entry id
  ("… — Harvest #12345"); ids stored on the row (migration `049_checkin_harvest_entry_ids`).
- **Buttons vs typed**: Slack block_actions were unreliable during churn; typed
  `yes`/`redo` is the reliable path (buttons remain wired). Check-in card posts FLAT
  in the DM (not threaded).

### Ted & Brown — record as of handoff (NONE logged to Harvest yet)

Ted (harvest_user_id 5688485):
| Date | Hours | Said | Resolves | Status | Loggable? |
|------|-------|------|----------|--------|-----------|
| 7/2 | 8h | "AI in meetings" | AI in Meetings (Meera) 2611 | parsed | ✅ via backfill |
| 7/6 | 8h | "internal" | — no project | parsed | ❌ needs Internal project |
| 7/7 | 8h | "internal" | — no project | parsed | ❌ needs Internal project |
| 7/8 | — | (no reply) | — | sent | — |

Brown (harvest_user_id 5688483):
| Date | Hours | Said | Resolves | Status | Loggable? |
|------|-------|------|----------|--------|-----------|
| 7/2 | — | (no reply) | — | sent | — |
| 7/6 | 8h | "Ignite Video Updates" | Ignite 2609 | parsed | ⚠️ conflict (see below) |
| 7/6 | 8h | "2611_MSFT_AI-in-Meetings" | Meera 2611 | parsed | ⚠️ conflict |
| 7/7 | 8h | "meera" ×2 (dupe) | AI in Meetings (Meera) 2611 | parsed | ✅ backfill dedupes to 1 |
| 7/8 | — | (no reply) | — | sent | — |

`/kit backfill-time` logs only **fully-matched** rows, **dedupes** by
(staff, date, project, hours), and is **idempotent** (only touches `parsed`).

---

## Open decisions

1. **Brown 7/6** — Ignite (2609) or Meera (2611)? Backfill as written logs the matched
   Ignite row. If Meera is correct, fix before/after running.
2. **Ted internal** — create "Internal" project in Harvest (under a "Ranger & Fox"
   client). Then "internal" fuzzy-matches and a re-run of `/kit backfill-time run`
   logs 7/6 + 7/7.
3. **Clear the slate** — after the above, wipe remaining stale `parsed`/`sent` rows.

---

## Everything else shipped this session (all merged)

- **Per-person timezones** (PR #70): check-ins fire at 5pm in each person's Slack-profile
  timezone (team spans PT/CT/ET); dates resolve on their local day. `staff.timezone`
  (migration 047), hourly cron sweep, `/kit sync-staff` refreshes tz.
- **Drive/Plaud transcripts** (PR #65): Zapier drops Plaud transcripts in a Google Drive
  folder; `driveTranscriptScan` cron ingests → classify → embed. Live (Drive API had to
  be enabled in GCP project `rf-kit-500717`; folder shared with
  `kit-373@rf-kit-500717.iam.gserviceaccount.com`).
- **Content-aware transcript→project matching** (PR #66): `matchTranscriptToProject`
  reads transcript body; multi-project weeklies stay workspace-level. `<br>` sanitized.
- **SRT → captions** (PRs #76, #78, #79): an `.srt` in `/Delivery-Queue/` OR a project
  accessibility folder (`02_Accessibility Files`, any "accessibility" folder under
  `/production/`) auto-generates TTML/VTT/TXT siblings, same basename. An `SRT` token in
  the filename is rewritten to the format (`Spot_SRT.srt` → `Spot_TTML.ttml`).
- **Per-project delivery routing** (PR #77): Delivery-Queue notifications post to the
  project's own Slack channel (folder name → project). `DELIVERY_NOTIFY_CHANNEL_ID` is now
  an optional fallback, not required.
- **Caveman skill** (PR #73): `.claude/skills/caveman/SKILL.md` — response compression.
  `.gitignore` narrowed to track `.claude/skills/`.

---

## Deploy / ops facts

- **Railway** runs bolt (Socket Mode + node-cron) from `main` via `bolt/Dockerfile`.
- **Vercel** runs Next.js + all Inngest crons (`src/app/api/inngest/route.ts`).
- **Supabase** project `ozsxrcgrezpffnpwlrnq` ("Kit"). Migrations 037–049 applied.
- No Harvest/Supabase creds in the Cowork/remote env — Harvest writes must run on
  Railway (i.e. via Slack commands), not from a session shell.
- Workflow: develop on `claude/laughing-ride-htu0dx`, PR → squash-merge → reset branch
  onto `main`. Commit trailer: `Co-Authored-By: Claude Opus 4.8` + `Claude-Session:` URL.
- Tests: `cd bolt && npx vitest run` (267 passing) + `npx tsc --noEmit` in bolt and root.

---

## Diagnostic logging left on (turn down later)

Added `console.log` on the typed-confirm path (`[checkin]`, `[checkin-confirm]`) to
diagnose the stuck confirm. Harmless but noisy in Railway — fold a removal into the
next real change.
