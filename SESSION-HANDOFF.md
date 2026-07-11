# Kit — Session Handoff (current)

Pick-up notes reflecting the current state of Kit. Supersedes the earlier
time-tracking-only handoff (that work is all done + merged). For the AE render
farm specifically, see `AE-RENDER-FARM-HANDOFF.md`.

Work is on branch `claude/laughing-ride-htu0dx`, PR'd → squash-merged to `main`
(deploys: Railway = bolt, Vercel = Inngest). Supabase project `ozsxrcgrezpffnpwlrnq`.

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
