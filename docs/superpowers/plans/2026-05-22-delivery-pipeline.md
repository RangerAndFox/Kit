# Delivery Pipeline Implementation Plan

> Spec: `DELIVERY-PIPELINE-SPEC.md` (repo root)

**Goal:** Ship the distributed video transcoding system per spec. Drop file in Dropbox → Kit prompts in Slack → render worker transcodes via FFmpeg → output lands in `/delivery/`.

**Approach:** Build in the phased order from the spec. Database first (entirely self-serve via Supabase MCP). Kit-side code next (no external deps). Render worker app last as a separate Node.js package because it deploys to Windows studio PCs, not Railway.

**What ships in this PR vs. operator-installed:**
- **PR contents:** all SQL, Kit-side libraries, Slack handlers, render worker source code, install script.
- **Operator steps after merge:** apply the migration, add Slack scopes, install the render worker on each studio PC (one-shot).

**Migration numbering:** main has 014-016. Briefings PR (#2) is 017, shot list (#3) is 018. Delivery pipeline uses **019** to leave room for both other PRs to merge cleanly.

---

## Phase 1 — DB migration `019_delivery_pipeline.sql`

Three tables from spec (`delivery_profiles`, `render_jobs`, `render_workers`). Indexes per spec. RLS enabled. Microsoft Ignite 2025 profile seeded inline.

Apply via Supabase MCP. Mirror file in repo.

## Phase 2 — Kit-side libraries (`src/lib/delivery/`)

Pure modules — no Slack or Supabase wiring, just business logic so they're unit-testable:

- `src/lib/delivery/types.ts` — shared types (DeliveryProfile, RenderJob, RenderWorker, ChannelMap, NamingFields).
- `src/lib/delivery/ffmpeg-builder.ts` — CODEC_MAP, AUDIO_CODEC_MAP, builds the full FFmpeg argv array from a profile + naming fields + input/output paths.
- `src/lib/delivery/channel-mapper.ts` — builds the `-af pan=...` filter from `audio_channels` JSON.
- `src/lib/delivery/loudness-parser.ts` — parses FFmpeg's pass-1 JSON output into `{input_i, input_tp, input_lra, input_thresh, target_offset}`.
- `src/lib/delivery/progress-parser.ts` — parses FFmpeg stderr lines like `frame= 1234 ... time=00:00:41.23` into percent + ETA.
- `src/lib/delivery/naming.ts` — applies `{session}_{speaker}_V{version}_{event}` template against `naming_fields`.
- `src/lib/delivery/storage.ts` — Supabase CRUD for profiles + jobs + workers.

Sanity script at `scripts/test-ffmpeg-builder.ts` covers the Ignite spec example end-to-end (SKIPs without env, deterministic without external calls).

## Phase 3 — Kit agent + Slack modals + commands

- `src/lib/inngest/agents/delivery.ts` — agent definition with the 7 capabilities listed in spec §"New Agent".
- Register in `src/lib/inngest/agents/registry.ts`.
- `bolt/src/delivery/` directory:
  - `select-profile-modal.ts` — builds the profile-selection modal Block Kit JSON.
  - `create-profile-modal.ts` — profile-creation modal.
  - `submit.ts` — view_submission handler for the select-profile modal → inserts a `render_jobs` row.
  - `create-profile-handler.ts` — view_submission handler for the create-profile modal.
  - `status.ts` — `/kit deliver status` and worker-status messages.
  - `keyword.ts` — `isDeliveryTrigger(text)` for @mention path.
- Wire into `bolt/src/handlers/commands.ts`:
  - `/kit deliver` (with optional Dropbox path arg) → opens profile selection modal
  - `/kit deliver status` → status card
  - `/kit profiles` / `/kit profiles create` / `/kit profiles edit <name>`
  - `/kit workers` / `/kit workers opt-out` / `/kit workers opt-in`
- Wire into `bolt/src/handlers/interactions.ts` for the modal callbacks.

## Phase 4 — Render worker app (`kit-render-worker/`)

Separate Node.js package (NOT inside `bolt/` or `src/`). Standalone because it deploys to Windows studio PCs, has its own lifecycle, and shouldn't pull in Next.js or Bolt deps.

Structure per spec §"Project Structure". Implementation hits:
- Heartbeat loop (10s) → `render_workers.last_heartbeat` upsert.
- Job claimer with `FOR UPDATE SKIP LOCKED` SQL (raw via Supabase) honoring primary vs fallback priority + 30s fallback delay.
- Job processor: spawn FFmpeg, parse stderr, update job progress every 5s.
- Two-pass loudness when `lufs_target` is set.
- Channel mapping using the same `channel-mapper.ts` logic (copied — worker shouldn't import from Kit's `src/`).
- Dropbox file resolver: prefer local sync path, fall back to API download.
- Config from `.env`.
- `install.ps1` PowerShell installer with prompts for role/priority/Dropbox path.
- README.

System tray app deferred (operator can run worker as a console window for v1).

## Phase 5 — Dropbox watcher (in Kit)

`src/lib/delivery/dropbox-watcher.ts` — cron function (Inngest) that:
- Polls `/Delivery-Queue/` via Dropbox `list_folder` API every 30s
- Tracks seen file ids in Supabase (small kv-style or just a `seen_dropbox_files` table)
- On new file: posts a Slack notification + opens a profile-selection modal trigger button
- Skips `/delivery/` subfolders, `.tmp`, `.part`, `~$*` files
- Waits for file stability (size unchanged across 2 polls)

## Phase 6 — Push + PR

Final review via subagent + end-of-PR review.

---

## Migration numbers reserved

| # | Branch | Purpose |
|---|---|---|
| 014 | main | Plaud migration |
| 015 | main | Create call_transcripts |
| 016 | main | RLS lockdown |
| 017 | feature/pre-meeting-briefings | meeting_briefings table |
| 018 | feature/shot-list-canvas | shot_lists table |
| 019 | feature/delivery-pipeline | delivery_profiles + render_jobs + render_workers |

## What's deferred to a follow-up

- System tray app (Electron / Win32 tray icon) — operator runs worker as a service/console for v1.
- Worker auto-update mechanism.
- AI-assisted profile generation from a spec PDF.
- Per-worker API keys (currently shares service-role key, ok inside studio LAN).
- Real-time progress streaming via Supabase Realtime (currently polls).
- QC checklist as interactive Slack checkboxes (v1 posts as a static list).
