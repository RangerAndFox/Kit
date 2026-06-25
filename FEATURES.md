# Kit — Feature Reference

A working reference for every feature Kit ships. Each section has:
- **Summary** — what it does, in plain English
- **Trigger** — how it gets invoked
- **Technical breakdown** — code locations, data flow, external services, env vars

Cross-cutting infrastructure (Supabase schema, Bolt server, deployment) is at the end.

---

## Table of contents

1. [New Project Provisioning](#1-new-project-provisioning)
2. [Slack Channel + Canvas Provisioning](#2-slack-channel--canvas-provisioning)
3. [Frame.io Project Provisioning](#3-frameio-project-provisioning)
4. [Dropbox Folder Provisioning](#4-dropbox-folder-provisioning)
5. [Harvest Project Provisioning](#5-harvest-project-provisioning)
6. [Storyboard Auto-Creation](#6-storyboard-auto-creation)
7. [Dropbox → Frame.io File Watcher](#7-dropbox--frameio-file-watcher)
8. [Conversational Assistant (Slack DM)](#8-conversational-assistant-slack-dm)
9. [Freelancer Onboarding](#9-freelancer-onboarding)
10. [Hours Check-Ins + Ad-Hoc Logging](#10-hours-check-ins--ad-hoc-logging)
11. [Shot List Canvas](#11-shot-list-canvas)
12. [Delivery Pipeline](#12-delivery-pipeline)
13. [Plaud Transcripts](#13-plaud-transcripts)
14. [Pre-Meeting Briefings](#14-pre-meeting-briefings)
15. [Studio Knowledge (project history, contacts, notes, auto-summarization)](#15-studio-knowledge)
16. [Infrastructure](#16-infrastructure)
17. [Environment variables](#17-environment-variables)

---

## 1. New Project Provisioning

### Summary
A producer types `new project` in a Slack DM with Kit (or runs the slash command). Kit posts a card with a "Open project form" button → a modal collects the project details and selected services → Kit fans out to Harvest, Dropbox, Frame.io, and Slack to provision everything in parallel, streaming progress back into the thread.

### Trigger
- Slack DM containing the phrase "new project" inside an Assistant thread
- `/kit newproject` slash command
- "Open project form" button on a previously posted card

### Technical breakdown

**Entry points**
- Card posted by `bolt/src/handlers/newproject-card.ts`
- Modal opened by the `kit_open_newproject_modal` action handler in `bolt/src/handlers/interactions.ts`
- Modal submission handled by the `kit_provision_project` view-submission callback in the same file

**Flow**
1. Card button click → modal opens via `buildNewProjectModal` (`src/lib/provisioner/modal.ts`)
2. User submits → form fields parsed → project row inserted into Supabase `projects` table (with `external_ids.dropbox_safe_name`, so the file watcher can reverse-match)
3. Two-phase `Promise.allSettled` fans out to each selected service via `dispatch(service, 'provision', payload)` from `src/lib/inngest/agents/registry.ts` — link-producing services first, then Slack last so its canvas gets the Dropbox/Frame.io URLs
4. Each progress update is `chat.postMessage`-ed back into the originating thread via the `postOpts({thread_ts})` helper
5. Final `external_links` and `status` (`active`/`partial`) updated on the project row
6. The project brain is auto-seeded (producers-only by default)

> **Single source of truth:** `bolt/src/handlers/interactions.ts` (`kit_provision_project`). Earlier duplicate provisioners — an MCP `runOrchestrator`, an Inngest `provisionProject`, and a legacy Next.js webhook route — were removed; they had diverged and produced project records the file watcher couldn't match.

**Key files**
- `bolt/src/handlers/interactions.ts` — the orchestrator (single source of truth)
- `src/lib/provisioner/modal.ts` — modal block kit definition
- `src/lib/inngest/agents/*.ts` — per-service provisioning logic

**Supabase**
- Inserts into `projects` with `workspace_id, name, client, project_code, project_type, status='provisioning', start_date, target_delivery, brief_summary, budget_total, project_manager_slack_id, external_ids`
- `external_ids` always populated with `{dropbox_safe_name}` so the [file watcher](#7-dropbox--frameio-file-watcher) can later reverse-match Dropbox paths
- After provisioning completes, `external_links` is populated with `{frameio: url, frameio_id: id, dropbox: url, slack_id: channel_id, ...}`

**Column-name gotcha**
Form fields don't map 1:1 to column names — see `~/.claude/projects/.../memory/project_kit_supabase_projects_schema.md`. Specifically:
- `form.description` → `brief_summary`
- `form.deadline` → `target_delivery`
- `form.budgetTotal` → `budget_total`
- `form.projectManager` → `project_manager_slack_id`

---

## 2. Slack Channel + Canvas Provisioning

### Summary
For each new project, Kit creates a Slack channel (`#{number}-{client}-{name}`), invites the PM + team members, sets the topic, posts a welcome message, and clones every canvas tabbed to the **template channel** (`C0B1312H89L`) into the new channel (each cloned as a standalone canvas tabbed to the channel header). Producers maintain templates by editing them in the template channel; no env-var changes needed.

### Trigger
Part of the [new-project provisioning](#1-new-project-provisioning) fan-out (`slack` service).

### Technical breakdown

**Code path**
- Agent: `src/lib/inngest/agents/slack.ts` — `provision` action
- Canvas duplication: `src/lib/mcp/slack.ts` → `duplicateTemplateCanvases`

**Dynamic template resolution**
`resolveCanvasTemplateFileIds()` calls `files.list(channel=C0B1312H89L, types=canvases)` at provision time and clones every canvas it finds (sorted by `created_at` ascending). To change what gets cloned: edit/add/remove canvases in the template channel — no redeploy required.

Override at runtime via `SLACK_CANVAS_TEMPLATE_FILE_IDS` env var if you ever need an explicit list. Override the template channel itself with `SLACK_TEMPLATE_CHANNEL_ID`.

**Canvas content conversion**
Slack canvases are stored as Quip-flavored HTML. We download via `files.info` → fetch `url_private_download` → run through `preprocessCanvasHtml` (strips `<control>`/`<lnk>` tags, flattens `<h1>-<h6>` and `<ul>` inside table cells so GFM tables stay on single lines) → Turndown → `sanitizeCanvasMarkdown` (unescapes `\_` so emoji shortcodes match, applies workspace emoji overrides like `:telephone_receiver:` → 📞) → `canvases.create` with the markdown.

**Workspace-custom emoji**
Shortcodes like `:microsoft-word:` and `:figma:` pass through unchanged. Slack's canvas renderer resolves them the same way it does in regular messages.

**Required scopes**
`channels:manage, channels:write.invites, channels:write.topic, canvases:read, canvases:write, files:read, chat:write`

---

## 3. Frame.io Project Provisioning

### Summary
Creates a Frame.io project named `{number}_{client}_{name}` under the studio's workspace and mirrors the folder structure of a designated **template project** (set via `FRAMEIO_TEMPLATE_PROJECT_ID`). Currently mirrors `03_Outgoing/{01_Client Progress, 02_Delivery}` and other folders from the template.

### Trigger
Part of the [new-project provisioning](#1-new-project-provisioning) fan-out (`frameio` service).

### Technical breakdown

**Code path**
- `src/lib/inngest/agents/frameio.ts` — `provision` action
- Uses Frame.io v4 API (`https://api.frame.io/v4`)

**Auth**
Adobe IMS OAuth via `src/lib/frameio/auth.ts` (client_credentials + refresh_token). Needs `FRAMEIO_ADOBE_CLIENT_ID, FRAMEIO_ADOBE_CLIENT_SECRET, FRAMEIO_ADOBE_REFRESH_TOKEN`.

**Folder mirroring**
`copyFrameioFolderTree(sourceFolderId, destFolderId, depth=0)` recursively walks the template project, creating each folder under the new project. Files/comments/shares aren't copied — just the folder names and hierarchy. Bounded by `MAX_TEMPLATE_DEPTH = 8`.

**Static fallback**
If `FRAMEIO_TEMPLATE_PROJECT_ID` is unset or template fetch fails, falls back to the flat list in `src/lib/provisioner/folder-structure.json` under the `frameio` key. The provisioner result records `mode: 'template' | 'static'` so logs make it clear which path ran.

---

## 4. Dropbox Folder Provisioning

### Summary
Creates `/production/{year}/{safeName}` in Dropbox by cloning the template folder (`/_TEMPLATES/New Project Template`) and generates a team share link.

### Trigger
Part of the [new-project provisioning](#1-new-project-provisioning) fan-out (`dropbox` service).

### Technical breakdown

**Code path**
- `src/lib/inngest/agents/dropbox.ts` — `provision` action

**Auth**
OAuth refresh-token flow via `src/lib/dropbox/client.ts`. Short-lived access tokens (~4h) are refreshed automatically using `DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN`. Cached in memory with a 5-minute safety buffer.

**Path computation**
```
safeName = [projectNumber, client, projectName]
  .filter(Boolean).join('_')
  .replace(/[^\w\s-]/g, '')
  .replace(/\s+/g, '_')
destPath = `/production/${year}/${safeName}`
```

This same shape is stored in Supabase `projects.external_ids.dropbox_safe_name` so the [file watcher](#7-dropbox--frameio-file-watcher) can reverse-match Dropbox paths back to projects.

**Namespace note**
The bot's Dropbox home is already the team folder root — paths are relative to it. Don't prefix `/Ranger & Fox/`.

**Template path override**
`DROPBOX_TEMPLATE_PATH` (default `/_TEMPLATES/New Project Template`).

---

## 5. Harvest Project Provisioning

### Summary
Creates a Harvest project under the studio's client account with `budget_by='project'` and the project budget pulled from the modal. Used for time tracking and invoicing.

### Trigger
Part of the [new-project provisioning](#1-new-project-provisioning) fan-out (`harvest` service).

### Technical breakdown

**Code path**
- `src/lib/inngest/agents/harvest.ts` — `provision` action

**Important constraint**
Harvest's API requires `budget` to be set at project-creation time. It cannot be edited afterwards via the API. The modal warns producers of this with the hint text under the Budget input.

---

## 6. Storyboard Auto-Creation

### Summary
A producer drops a script file (or types `storyboard`) in their Slack DM with Kit. Kit opens a small modal to confirm the project name + AR, then creates a Boords storyboard with each scene auto-split, posts the share link back into the thread.

### Trigger
- File drop in a Slack Assistant thread (script file types: `.txt, .md, .docx`, etc.)
- Slash command or keyword `storyboard` in an Assistant thread

### Technical breakdown

**Code path**
- Detection: `bolt/src/handlers/messages.ts` → `isStoryboardScriptFile`, `isStoryboardTrigger`
- Modal: `src/lib/storyboard/modal.ts`
- Script parsing: `src/lib/storyboard/files.ts` → `extractScriptFromFile`
- Stash for round-tripping: `src/lib/storyboard/stash.ts`
- Submit handler: `kit_open_storyboard_modal` action + view-submission in `bolt/src/handlers/interactions.ts`

**Stash pattern**
Slack `view.private_metadata` is limited to ~3 KB, so the parsed script can't round-trip through it. Instead, on intake we save the script (or file pointer) keyed by a UUID via `stashIntake()`, and put only the UUID into the modal's private_metadata. `takeIntake()` retrieves on submit. Entries TTL after 30 minutes.

**Assistant thread context**
The `assistantThreadTs` is captured at file-drop time (for file uploads) or backfilled from the button-click `body.container.thread_ts` (for slash command + keyword flows) via `updateIntake(token, {assistantThreadTs})`. All progress + success messages are posted with `thread_ts` set so they land inside the Assistant view.

**Boords integration**
- JSON:API envelope: responses wrap in `{data: {...}}`
- AR uses `16x9` (not `16:9`)
- Team is discovered via `GET /me` on first call
- Project creation: flat `POST /v1/projects` with `team_id` in the body (not in the URL)

See memory `~/.claude/projects/.../memory/project_kit_boords.md` for full gotchas.

---

## 7. Dropbox → Frame.io File Watcher

### Summary
When a producer drops a file into a project's `09_Outgoing/{01_Client Progress | 02_Delivery}` folder on Dropbox, Kit automatically uploads it to the same project's `03_Outgoing/{same subfolder}` on Frame.io, generates a share link, and DMs the project's PM with the link. Folder hierarchy is mirrored (so a date-named subfolder like `051426` on Dropbox is recreated on Frame.io). Works for newly-provisioned projects automatically, and for existing projects via dynamic Frame.io lookup + auto-backfill.

### Trigger
Dropbox webhook on file change anywhere under `/production/...`.

### Technical breakdown

**Code path**
- Webhook endpoint: `bolt/src/app.ts` — routes `GET/POST /webhooks/dropbox` on the same HTTP server Railway uses for health checks
- Watcher logic: `bolt/src/watchers/dropbox.ts`

**Webhook verification**
- `GET /webhooks/dropbox?challenge=...` → echo the challenge back as `text/plain` (one-time Dropbox verification)
- `POST /webhooks/dropbox` → HMAC-SHA256 of raw body using `DROPBOX_APP_SECRET`, compared in constant time against `X-Dropbox-Signature` header. 403 on mismatch.

**Cursor-delta polling**
Single shared cursor stored in Supabase `dropbox_state` (singleton row, id='singleton'). On first webhook hit, seeds with `/files/list_folder/get_latest_cursor` for `/production` recursive. Subsequent hits call `/files/list_folder/continue` and process all returned entries.

**Path matching**
Regex: `^/production/(\d{4})/([^/]+)/09_Outgoing/(01_Client Progress|02_Delivery)/(.+)$`. Captures year, safeName, subfolder, and the rest of the path (which may include intermediate subfolders).

**Project lookup chain**
1. Supabase `projects WHERE external_ids->>dropbox_safe_name = $safeName`
2. If miss: extract project number from safeName (e.g., `2620_Microsoft_FoundryIQSizzle` → `2620`, `2612B_Microsoft_...` → `2612B`) using regex `/^(\d+[A-Za-z]?)(?=[^A-Za-z0-9]|$)/`
3. List Frame.io workspace projects, find one whose name starts with that number (strict) or contains it (lenient fallback)
4. UPSERT a Supabase row capturing `external_ids.dropbox_safe_name` + `external_links.frameio_id` so the second file drop hits the cache

**Folder mirroring**
For a Dropbox path `…/02_Delivery/051426/v1/asset.mp4`:
1. Find Frame.io `03_Outgoing` under project root
2. Find `02_Delivery` under it
3. Walk `["051426", "v1"]`, finding-or-creating each folder
4. Upload `asset.mp4` to the leaf folder via `remote_upload`

**Upload mechanism**
Frame.io v4 `POST /accounts/{acct}/folders/{folder_id}/files/remote_upload` with `data: {name, source_url}`. The source_url is a 4-hour Dropbox temporary link from `/files/get_temporary_link`, so the Bolt server never buffers bytes — Frame.io fetches directly.

**Share link**
`POST /accounts/{acct}/share_links` with `data: {name, items: [{id, type:"file"}]}`. If that fails, falls back to `file.view_url` from the upload response, then to a constructed `https://next.frame.io/project/{id}/view/{file_id}` URL.

**Notification routing**
1. `project_manager_slack_id` if set → DM
2. `external_links.slack_id` if set → post in the project's Slack channel
3. `KIT_FALLBACK_PM_SLACK_ID` env var → DM that user
4. Skip with log

---

## 8. Conversational Assistant (Slack DM)

### Summary
DM Kit in Slack and it talks back like a chief-of-staff, routing your questions to the right specialist agent (Harvest, Frame.io, Dropbox, Boords, Slack) and stitching the answer back into the Assistant thread.

### Trigger
Any DM to Kit, or any `@Kit` mention in a channel.

### Technical breakdown

**Code path**
- Entry: `bolt/src/app.ts` → `Assistant.userMessage` for DMs, `bolt/src/handlers/messages.ts` for channel mentions
- Orchestrator: `bolt/src/llm/orchestrator.ts`
- Per-domain prompts: `bolt/src/llm/prompts/*-system.ts` (harvest, dropbox, frameio, boords, slack)
- Tool dispatcher: `bolt/src/llm/tools.ts`
- LLM client: `bolt/src/llm/client.ts` (Anthropic)

**Slack Assistant integration**
Uses Slack's "Agents & AI Apps" feature. DMs arrive as `Assistant.userMessage` events with a stable `thread_ts`. All replies go back in that thread.

**Routing**
The orchestrator sends the user message to Anthropic with a system prompt describing the available domain specialists. Each specialist is exposed as a tool the model can call. The model decides which specialist (or specialists, in parallel) to invoke, the tool runs against the matching agent, and the result is fed back to the model for a final user-facing response.

---

## 9. Freelancer Onboarding

### Summary
PMs and CDs onboard a contractor across Slack, Dropbox, Frame.io, and Harvest in one shot. Permission-gated to `staff.role IN ('producer','cd','admin')`.

### Trigger
- `/kit onboard` — opens the modal (50-project static_select + 3 artist slots).
- `@Kit onboard alice@example.com to Rayfin` — conversational; Kit holds pending-onboarding state per (channel, user) for 15 minutes so follow-up replies without `@Kit` are picked up.

### Technical breakdown

**Code path**
- Trigger detection: `bolt/src/onboarding/keyword.ts`
- Modal: `bolt/src/onboarding/modal.ts`
- Orchestrator: `bolt/src/onboarding/orchestrator.ts` runs four services in parallel via `Promise.all`
- Per-service implementations: `bolt/src/onboarding/services/{slack,dropbox,frameio,harvest}.ts`
- Project resolution: `bolt/src/onboarding/rehydrate.ts` auto-discovers missing `external_links` keys via API lookups
- Permission gate: `bolt/src/onboarding/permissions.ts` (`canOnboard(slackUserId)`)
- Per-row tracking: Supabase `freelancer_onboardings` table

**Per-service behavior**
- **Slack:** `conversations.inviteShared` for non-workspace artists (Business+ compatible Slack Connect invite); `conversations.invite` for existing members.
- **Dropbox:** `sharing/share_folder` + `sharing/add_folder_member` with email. Reads `external_links.dropbox_id`.
- **Frame.io:** No v4 invite-by-email endpoint exists. Kit looks up the user by email (paginated `GET /accounts/{acct}/users?sort=email_asc`), then PATCHes the project user with role. If the user isn't yet in the Frame.io account, Kit surfaces a `https://next.frame.io/signup?email=...` link in the welcome message.
- **Harvest:** Studio runs at seat cap, so a shared "freelancers" bucket user is reused. Set `HARVEST_FREELANCER_USER_ID` to that user's id. Kit calls `assignUserToProject` idempotently. Real per-freelancer hours get logged under the bucket with the artist's name in the notes field.

**Welcome message**
Pulled from a Slack canvas the studio maintains (markdown content). Kit fetches via `files.info` + `url_private_download`, combines with project summary + action URLs (Frame.io signup link if needed), and DMs the artist (or posts in the project channel if they're not yet in Slack Connect).

**Slack scopes that matter**
Note: admin scopes (`admin.users:write`, `admin.invites:write`) require Enterprise Grid; Slack Connect (`conversations.connect:write`) works on Business+ and is what Kit uses.

---

## 10. Hours Check-Ins + Ad-Hoc Logging

### Summary
At 5pm Mon-Fri Kit DMs each in-house creative ("How'd your day go?"), parses the natural-language reply via Claude Haiku, fuzzy-matches Harvest projects, and writes confirmed entries to Harvest. Same parser handles unprompted ad-hoc messages like `log 4h on Acme review yesterday`. Only fires for `employment_type='employee'`; freelancers and contractors are skipped (they log directly in Harvest).

### Trigger
- **Scheduled:** `node-cron` cron at 5pm + 10pm Mon-Fri (timezone via `CHECKIN_TIMEZONE`, default `America/Los_Angeles`).
- **Ad-hoc:** any unprompted message to Kit that looks like an hours entry — phrases like `log 4h on X`, `2.5 hours on Y`, `worked 3 hours on Z`.

### Technical breakdown

**Code path**
- 5pm sender: `bolt/src/checkins/daily-hours.ts`. Loads `staff` rows with `role='creative'`, `employment_type='employee'`, `is_active=true`. Pulls each person's last 7 days of Harvest entries, ranks projects by recent activity, picks top 3 as candidates, DMs them.
- Reply parser: `bolt/src/checkins/reply.ts` — Haiku call with structured-output prompt → returns array of `{project_match, hours, notes}` entries.
- Ad-hoc fast path: `bolt/src/checkins/adhoc.ts` — detects unprompted hours intent, runs the same parser, gates on `employment_type === 'employee'`.
- Confirmation card + write: `bolt/src/checkins/confirm.ts` — Block Kit buttons (`kit_checkin_confirm` / `kit_checkin_redo`); on confirm, calls `createTimeEntry` per parsed entry.
- Time entry client: `src/lib/harvest/time-parser.ts` + `src/lib/harvest/client.ts`.
- DB tracking: `daily_hours_checkins` rows with `staff_id`, `slack_user_id`, `check_in_date`, `status`, `parsed_entries`, `dm_channel_id`, `dm_ts`, `origin` ('scheduled' | 'adhoc').

**Duplicate guard**
Before posting a scheduled DM, the sender checks for any existing row for `(staff_id, check_in_date)` with status `scheduled` OR `logged`. Skips if found.

**Sync to staff table**
`bolt/scripts/sync-staff.ts` is a one-shot that pulls Slack `users.list` + Harvest `listUsers` and upserts into `staff` with role + employment_type. Run after onboarding new team members.

---

## 11. Shot List Canvas

### Summary
Conversational Boords-style shot list creator that lives as a Slack Canvas in each project channel. User pastes a script; Kit parses to structured shots and creates a channel canvas with a markdown table (shot # / visual / sound-dialogue / duration / reference image). Drops images afterward → Kit attaches them to shots in order. Subsequent natural-language edits ("add a close-up between 2 and 3") apply structured mutations and re-render the canvas in place.

### Trigger
- `@Kit shot list from this: <script>` — fresh build (or replace existing).
- `@Kit add/remove/edit shot <N>` — mutation against the existing canvas.
- `/kit shotlist <script>` — slash command variant.
- File upload of an image in the same channel — attaches to next un-thumbnailed shot.

### Technical breakdown

**Code path**
- Module: `bolt/src/shotlist/` — full feature in one directory.
  - `types.ts` — `Shot`, `ShotList`, `ShotMutation`
  - `keyword.ts` — `isShotListTrigger` (excludes "shot of espresso" false positives)
  - `parser.ts` — Claude Haiku, two modes: `parseScript` (free-form → Shot[]) and `parseMutation` (instruction + existing list → ShotMutation)
  - `renderer.ts` — Shot[] → markdown table with embedded image refs
  - `canvas.ts` — Slack Web API wrappers (`conversations.canvases.create` with `title` param, `canvases.edit` with both `rename` + `replace` operations)
  - `storage.ts` — `shot_lists` table read/write
  - `thumbnails.ts` — handles `message.file_share` events with images, attaches to next un-thumbnailed shot, re-renders
  - `handler.ts` — orchestrator (parse vs. mutate routing, canvas create/update, response message)

**Canvas title format**
`<project number>_<project name>_Shot List` (e.g. `2566_Sizzle_Shot List`) when the channel is linked to a Kit project. Title set via `conversations.canvases.create({title})` on create and `canvases.edit({changes: [{operation: 'rename', title_content: ...}]})` on update — H1 in markdown affects only the body, not the tab name.

**Mutation routing**
If `shot_lists` row exists AND the message doesn't look like a fresh script (no `from this:` prefix, no long multi-line body), route to `parseMutation`. Otherwise `parseScript`. Prevents "give me 5 more shots" from silently replacing the existing list.

**Insert-at-0 handling**
`applyMutation` treats `after_shot_number ≤ 0` as "insert at front" (Haiku sometimes emits `after_shot_number: 0`).

**Uniqueness constraint**
`shot_lists.slack_channel_id` is unique — one canvas per channel. Upsert uses `onConflict: 'slack_channel_id'` to prevent race-duplicates.

**Required Slack scope**
`canvases:write` (already added).

---

## 12. Delivery Pipeline

### Summary
Distributed video transcoding via FFmpeg. Drop a file in `/Delivery-Queue/<project>/` on Dropbox; Kit posts to Slack with a "Pick a profile" prompt; a render worker (running on a studio PC) claims the job, transcodes to broadcast specs (ProRes, two-pass loudness normalization, channel mapping, naming conventions), and writes the output to `/Delivery-Queue/<project>/delivery/`. Microsoft Ignite 2025 profile is seeded.

### Trigger
- Auto: file lands in `/Delivery-Queue/` on Dropbox → cron detects (60-90s latency) → Slack notification with "Pick profile" link.
- Manual: `/kit deliver <dropbox path>` opens the profile-selection modal.
- Status: `/kit deliver status` shows recent jobs + progress.
- Profiles: `/kit profiles`, `/kit profiles create`, `/kit profiles edit <name>`.
- Workers: `/kit workers`, `/kit workers opt-out <hostname>`, `/kit workers opt-in <hostname>`.

### Technical breakdown

**Kit-side libraries** (`src/lib/delivery/`)
- `ffmpeg-builder.ts` — CODEC_MAP (`prores_ks`, `libx264`, `dnxhd`), AUDIO_CODEC_MAP, `buildLoudnessAnalysisArgs` (pass 1), `buildFFmpegArgs` (pass 2), `argsToShellCommand`.
- `channel-mapper.ts` — `buildChannelMapFilter` (stereo / 5.1 / silent), `requiresAmerge` for external-file sources.
- `loudness-parser.ts` — parses pass-1 JSON stderr into `{input_i, input_tp, input_lra, input_thresh, target_offset}`.
- `progress-parser.ts` — extracts `time= / fps=` from FFmpeg stderr, computes percent + ETA against source duration.
- `naming.ts` — `applyNamingTemplate('{session}_{speaker}_V{version}_{event}', fields)` collapses unfilled tokens and trims separators.
- `storage.ts` — Supabase CRUD over `delivery_profiles`, `render_jobs`, `render_workers` + `resetStaleJobs(thresholdSeconds=60)`.
- `dropbox-watcher.ts` — list `/Delivery-Queue/` recursively, exclude `/delivery/` outputs and `.tmp`/`.part`/`.crdownload` files, file-stability check across 2 polls before notifying.

**Inngest crons** (`src/lib/inngest/delivery-crons.ts`)
- `delivery-dropbox-scan` — every 60s, scans `/Delivery-Queue/`, posts new files.
- `delivery-job-notifier` — every 60s, posts Slack updates when `render_jobs.status` transitions (claimed → processing → complete/failed). Idempotency via `slack_notified_status` column.
- `delivery-stale-sweep` — every 60s, resets jobs whose worker hasn't heartbeated in 60s.

**Render worker** (`kit-render-worker/`)
Standalone Node.js package deployed to Windows studio PCs.
- `src/index.ts` — entry point.
- `src/heartbeat.ts` — every 10s upserts `render_workers` row with CPU/memory/disk + current_job_id.
- `src/job-claimer.ts` — primary workers poll every 5s, fallback workers every 15s + only claim jobs >30s old. UPDATE...WHERE status='pending' is the atomicity primitive (concurrent updates serialize at row lock).
- `src/job-processor.ts` — orchestrates: probe duration → (if `lufs_target`) pass-1 loudness → pass-2 transcode → mark complete with output_path, output_size_bytes, duration_seconds.
- `src/ffmpeg/runner.ts` — `runFFmpeg` spawns child process, bounds stderr to 64KB, debounces progress updates to every 2s.
- `src/dropbox/file-resolver.ts` — resolves `/Delivery-Queue/...` to local sync path; v1 doesn't fall back to API download.
- `install.ps1` — PowerShell installer with prompts for role/priority/Dropbox path/FFmpeg path.

**Schema** (migrations 019 + 020)
- `delivery_profiles` — full reusable spec (video/audio/loudness/container/naming/QC checklist).
- `render_jobs` — job queue with status enum (`pending|claimed|processing|complete|failed|cancelled`), `profile_snapshot` jsonb (frozen at submit so live edits don't affect in-flight), `slack_notified_status` + `slack_message_ts` for idempotent notifier, `source_files` jsonb array (supports multi-file inputs).
- `render_workers` — `hostname unique`, `role IN ('primary','fallback')`, status enum, heartbeat fields, `current_job_id` FK, `cpu_threshold`, `dropbox_sync_path`, `ffmpeg_path`, opt-out fields.
- `seen_dropbox_files` — polling state for the watcher (file-stability counter).

**Activation gate**
`DELIVERY_NOTIFY_CHANNEL_ID` env var. Without it the auto-detect cron is silent but `/kit deliver <path>` still works manually.

---

## 13. Plaud Transcripts

### Summary
Plaud (https://plaud.ai) hardware recorder posts `transcription.completed` webhooks to Kit. Kit verifies HMAC, fetches transcript via Plaud API, classifies the project via the CALL_PROCESSOR managed agent, ingests to RAG, and updates `call_transcripts`. Plus auto-embeds for studio-knowledge retrieval (P4 wiring).

### Trigger
Plaud webhook → `POST /api/webhooks/plaud`. Activates when `PLAUD_INGEST_ENABLED=true`.

### Technical breakdown

**Webhook receiver** (`src/app/api/webhooks/plaud/route.ts`)
- Reads raw body via `request.text()`.
- HMAC-SHA256 verifies `plaud-signature: sha256=<hex>` over `${plaud-timestamp}.${rawBody}` using `PLAUD_WEBHOOK_SECRET` (constant-time compare via `crypto.timingSafeEqual` on decoded Buffers).
- Replay-protection: rejects `|now - plaud-timestamp| > PLAUD_TIMESTAMP_SKEW_SECONDS` (default 300, clamped to (0, 3600]).
- Dispatches `transcription.completed` → Inngest event `plaud/transcription.ready`; `transcription.failed` → `plaud/transcription.failed`. Unknown events log + 200 (forward compatibility).
- Top-level try/catch around the handler body so `request.text()` aborts return controlled 500.

**Inngest functions** (`src/lib/inngest/plaud.ts`)
- `plaudTranscriptionReady` (retries: 2, idempotency: `event.data.transcription_id`)
  - `upsert-skeleton` — inserts `call_transcripts` row with `source='plaud'`, `ingest_status='pending'`, IDs only. `ignoreDuplicates: true` on the upsert prevents late retries from regressing already-ingested rows back to pending.
  - If `PLAUD_INGEST_ENABLED=false`, returns early.
  - `fetch-plaud-file` + `fetch-plaud-transcript` — calls the Plaud Transcription API with `PLAUD_API_KEY`.
  - `route-to-call-processor` — hands to `webhook-router.ts` `transcript` route → CALL_PROCESSOR managed agent for project classification + RAG ingest. Requires `KIT_DEFAULT_WORKSPACE_ID` (throws loudly if unset rather than landing empty-string FK).
  - `mark-ingested` — updates row with transcript text + `ingest_status='ingested'`.
  - `embed-into-rag` — calls `embedTranscript` (from `src/lib/studio-knowledge/transcript.ts`) to chunk + embed the transcript into `project_documents` with `doc_type='call_transcript'`. Failures are warned-and-swallowed (non-fatal — `call_transcripts` row is still good, can be re-embedded later).
- `plaudTranscriptionFailed` (retries: 0 — failure-of-failure-handler shouldn't retry storm) — writes `ingest_status='failed'`, optionally posts to `PLAUD_ERROR_CHANNEL_ID`.

**Plaud API client** (`src/lib/integrations/plaud.ts`)
- `verifyPlaudSignature` — byte-buffer comparison, constant-time, false on malformed input.
- `isTimestampFresh` — clamped skew (0-3600s).
- `fetchPlaudTranscript(transcriptionId)` / `fetchPlaudFile(fileId)` — flag-gated; both throw `PLAUD_INGEST_ENABLED is false` until activation.

**Schema** (migrations 014 + 015)
`call_transcripts` has `external_recording_id` (unique), `external_file_id`, `source` ('plaud'|'manual'|'granola'), `ingest_status`, plus nullable transcript/participants/start_time/end_time for the skeleton-then-hydrate flow. Migration 015 created the table from scratch (Granola code had referenced it but no migration ever shipped).

**Status:** code skeleton live; waiting on Plaud dev portal approval (see `OPERATOR-TODO.md` §D).

---

## 14. Pre-Meeting Briefings

### Summary
Inngest cron polls Google Calendar every 15 minutes for upcoming events. For each event, classifies to a Kit project via Claude Haiku; if confidence ≥ threshold, schedules a delayed dispatch event for ~30 minutes before meeting start. At dispatch, Kit composes a briefing (project header, meeting context, recent Frame.io / Dropbox links, last Plaud transcript summary if available, open `kit_actions`) and posts to the project's Slack channel.

### Trigger
Inngest cron `0,15,30,45 * * * *` (every 15 min). Activates when `GOOGLE_CALENDAR_INGEST_ENABLED=true`.

### Technical breakdown

**Source of truth**: Google Calendar. Plaud transcripts are an optional content source for the briefing body, never in the trigger path.

**Calendar auth** (`src/lib/integrations/google-calendar.ts`)
Service-account JWT (not 3-legged OAuth) — one shared service account, calendars shared with its `client_email`. Reads `GOOGLE_SERVICE_ACCOUNT_JSON` (raw or base64). `fetchUpcomingEvents(fromIso, toIso)` lists events from configured `GOOGLE_CALENDAR_IDS` with `singleEvents: true`.

**Project matcher** (`src/lib/agent/meeting-classifier.ts`)
Claude Haiku with priority-ranked match rules (project_code in title → attendees → keywords). Returns `{project_id, confidence, reasoning}`. JSON-only output, "prefer null over low-confidence" prompt rule. Confidence threshold (`BRIEFING_MATCH_THRESHOLD`, default 0.5).

**Briefing composer** (`src/lib/agent/briefing-composer.ts`)
Pulls project + open `kit_actions` (where `status IN ('pending','approved')`) + last `call_transcripts` row (source='plaud'). Composes Slack mrkdwn body. Returns `{channelText, producerDmText, projectChannelId, producerSlackUserId}`.

**Inngest functions** (`src/lib/inngest/pre-meeting.ts`)
- `preMeetingScan` (cron, every 15m) — fetches events from `[now, now + lead + 16min]`, classifies each, upserts `meeting_briefings` row with status (`pending`/`skipped`/`failed`), schedules a `pre-meeting/dispatch` event for `start - lead` (lead = `BRIEFING_LEAD_TIME_MINUTES`, default 30).
- `preMeetingDispatch` (event-triggered, idempotency: `event.data.event_id`) — composes briefing, posts to channel, optionally DMs producer (gated by `BRIEFING_DM_PRODUCER=true`, default off until project→producer mapping exists), updates row with `status='sent'`.

**Multi-tenancy safety**
The active-projects query in the scanner uses `KIT_DEFAULT_WORKSPACE_ID` to scope (warns if unset).

**Schema** (migration 017)
`meeting_briefings` — `event_id` (unique), `calendar_id`, `project_id` (FK, set null on delete), `meeting_title`, `meeting_start_time`, `attendees_json`, `briefing_md`, `slack_*` fields, `confidence`, status enum, `error`.

**Status:** code skeleton live; awaiting Google service-account setup (see `OPERATOR-TODO.md` §C).

---

## 15. Studio Knowledge

### Summary
Kit has full historical context once activated — every project the studio's worked on, every client and contact, plus freeform notes captured in Slack. Backed by semantic search (OpenAI text-embedding-3-small + pgvector cosine via the `match_documents` Supabase RPC) plus structured Supabase lookups. Nightly Claude Haiku re-summarization keeps project 1-pagers current with narrative context.

### Trigger
Any @mention / DM. Kit's orchestrator decides automatically when to call `ask_studio_knowledge`. Plus an explicit `@Kit note for X: ...` path for capturing notes.

### Technical breakdown

**Agent** (`src/lib/inngest/agents/studio-knowledge.ts`)
Registered as `ask_studio_knowledge` tool. Ten actions:
- `search(query, projectId?, limit)` — semantic search via `match_documents` RPC, returns `{results, context}` where `context` is a prompt-ready citation block.
- `lookup_project(query|code|name)` — exact `project_code` first, then ilike fuzzy on name/client/code.
- `recent_projects(limit)` — by `start_date` descending.
- `lookup_client(query|name)` — exact `client_name` then ilike.
- `find_contact(query|name|email)` — scans `client_profiles.primary_contacts` jsonb in JS, returns `{client_name, contact}` hits.
- `recent_clients(limit)` — by `total_lifetime_revenue` descending.
- `reembed_all(workspaceId?)` — re-embed every project's `project_summary` doc.
- `reembed_clients(workspaceId?)` — re-embed every `client_profiles` row.
- `reembed_transcripts(workspaceId?)` — embed any ingested `call_transcripts` that don't have a corresponding `project_documents` row yet (idempotent via `metadata->>call_transcripts_id`).
- `regenerate_summary(projectId?, workspaceId?)` — Claude Haiku rewrites a project's 1-pager from notes + transcripts + actions; omit `projectId` to regenerate all.

**RAG core** (`src/lib/rag/`)
- `embeddings.ts` — OpenAI `text-embedding-3-small` (1536 dims, batched at 100/request, shape-validated).
- `query.ts` — calls `match_documents(query_embedding, match_count, filter_workspace_id, filter_project_id)` Postgres RPC (pgvector v0.8.0 cosine search; SECURITY DEFINER with built-in visibility filtering). Returns rows with similarity scores. `buildContext(results, maxChars)` packs results into a citation-tagged context string with trim-from-lowest-similarity.
- `ingest.ts` — single-row-per-document write to `project_documents` with inline `embedding` vector. Helpers: `ingestDocument`, `upsertDocument` (idempotent by `workspace_id + doc_type + title`), `ingestLongDocument` (chunks long text at 1500 chars / 300 overlap), `deleteDocument`.

**Studio-knowledge helpers** (`src/lib/studio-knowledge/`)
- `project-summary.ts` — `composeProjectSummaryText(project)` formats structural fields + brief + SOW into a markdown summary; `embedProjectSummary` upserts as `doc_type='project_summary'`; `embedAllProjects(workspaceId)` iterates.
- `client-profile.ts` — same shape for `client_profiles` rows (`doc_type='client_profile'`).
- `transcript.ts` — `composeTranscriptTitle` (Plaud/Granola/Manual + date + first ≤3 participant names); `embedTranscript` uses `ingestLongDocument` so long transcripts split into multiple `doc_type='call_transcript'` rows with `metadata.call_transcripts_id` pointing back; `backfillTranscriptsIntoRag(workspaceId)` for cleanup re-runs.
- `auto-summarize.ts` — `regenerateProjectSummary` pulls recent notes + transcripts (top 20 / top 10 by `created_at`) + open `kit_actions`, asks Claude Haiku to write a ~250-word narrative, upserts. Falls back to the static `embedProjectSummary` when there's no material to draw from.

**Notes capture** (`bolt/src/notes/`)
- `keyword.ts` — regex detectors for `note for X:`, `note:`, `remember [that] X [for Y]`.
- `handler.ts` — project resolution (explicit hint → fuzzy match, or channel's linked project, or ask). On match, calls `ingestDocument` with `doc_type='note'` + `metadata.captured_by_slack_user_id`. Confirms with `:writing_hand: Note saved to *X*`.

**Nightly cron** (`src/lib/inngest/studio-knowledge-cron.ts`)
- `studioKnowledgeAutoSummarize` (cron `0 9 * * *` = 9am UTC = 5am ET; `STUDIO_KNOWLEDGE_AUTO_SUMMARIZE_ENABLED` flag-gated).
- Iterates active+archived projects ordered by `updated_at` desc (cap 200), calls `regenerateProjectSummary` per project.

**Backfill scripts**
- `scripts/backfill-projects-from-harvest.ts` — pulls every Harvest project, upserts to `projects` (idempotent on `harvest_project_id`), then `embedAllProjects`.
- `scripts/backfill-clients-from-harvest.ts` — pulls `/v2/clients` + `/v2/contacts`, upserts to `client_profiles` (idempotent on `harvest_client_id`), derives `project_count` + `total_lifetime_revenue` from local `projects`, then `embedAllClients`.

**Schema**
Existing `project_documents` (pgvector embedded column, `match_documents` RPC) + `client_profiles` (extended with `harvest_client_id` in migration 023). No new tables — all notes/transcripts/summaries flow into `project_documents` with distinct `doc_type` values.

**Status:** code live; needs `OPENAI_API_KEY` set and the two backfill scripts run once (see `OPERATOR-TODO.md` §A1-A3).

---

## 16. Infrastructure

### Bolt server

- **Stack**: `@slack/bolt@4.7` Socket Mode, TypeScript via `tsx` (no compile step)
- **Entry point**: `bolt/src/app.ts`
- **Runtime**: Node 20 on Railway
- **HTTP server**: Health endpoint on `$PORT` for Railway lifecycle + Dropbox webhook routes
- **Persistent process**: No 60-second serverless timeout — provisioning runs directly in the request handler, streaming updates back as it goes

### Supabase

**Project**: `ozsxrcgrezpffnpwlrnq` (URL in `.env.local` as `NEXT_PUBLIC_SUPABASE_URL`)

**Tables**

`projects` — one row per provisioned project
- `id (uuid pk), workspace_id, name, client, project_code, project_type`
- `status` — `'provisioning' | 'active' | 'partial'`
- `start_date, target_delivery, brief_summary, budget_total`
- `project_manager_slack_id` — Slack user ID, populated at provision time
- `external_ids` — jsonb, contains `dropbox_safe_name` and any other per-service tracking IDs
- `external_links` — jsonb, contains `frameio, frameio_id, dropbox, slack_id, harvest_id, ...`

`dropbox_state` — singleton row for the file watcher's cursor
- `id text pk default 'singleton'`
- `cursor text` — latest Dropbox `/files/list_folder/continue` cursor
- `updated_at timestamptz`

### Adobe IMS (Frame.io auth)

- `src/lib/frameio/auth.ts` exchanges `client_id + client_secret + refresh_token` for a short-lived bearer token at `https://ims-na1.adobelogin.com/ims/token/v3`
- Cached in memory with `Date.now() + expires_in * 1000 - 5min`

### Dropbox OAuth

- `src/lib/dropbox/client.ts` exchanges `app_key + app_secret + refresh_token` for a short-lived bearer token at `https://api.dropboxapi.com/oauth2/token`
- Same caching pattern as Frame.io

### Railway deployment

- Auto-deploys from `main` on push (https://github.com/steve-rangerandfox/Kit.git)
- Public domain enabled on the Bolt service so Dropbox can reach `/webhooks/dropbox`
- Webhook URL registered at dropbox.com/developers → app → Webhooks tab

---

## 17. Environment variables

### Slack (Bolt)
- `SLACK_BOT_TOKEN` — xoxb-...
- `SLACK_APP_TOKEN` — xapp-... (Socket Mode)
- `SLACK_TEMPLATE_CHANNEL_ID` — defaults to `C0B1312H89L`
- `SLACK_CANVAS_TEMPLATE_FILE_IDS` — optional comma-separated override

### Anthropic
- `ANTHROPIC_API_KEY`

### Supabase
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — used by the admin client

### Dropbox
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET` — also used to verify webhook HMACs
- `DROPBOX_REFRESH_TOKEN`
- `DROPBOX_TEMPLATE_PATH` — defaults to `/_TEMPLATES/New Project Template`

### Frame.io (Adobe IMS)
- `FRAMEIO_ADOBE_CLIENT_ID`
- `FRAMEIO_ADOBE_CLIENT_SECRET`
- `FRAMEIO_ADOBE_REFRESH_TOKEN`
- `FRAMEIO_ACCOUNT_ID`
- `FRAMEIO_WORKSPACE_ID`
- `FRAMEIO_TEMPLATE_PROJECT_ID` — currently `c25dfd9f-ad57-4b88-8a6f-f829ac2d100d`

### Harvest
- `HARVEST_ACCOUNT_ID`
- `HARVEST_ACCESS_TOKEN`

### Boords
- `BOORDS_API_TOKEN`

### File watcher
- `KIT_FALLBACK_PM_SLACK_ID` — optional, DMs this user when the project has no PM or linked channel

### Railway
- `PORT` — auto-set by Railway

### Plaud (transcripts)
- `PLAUD_WEBHOOK_SECRET` — HMAC signing key from the Plaud developer console
- `PLAUD_API_KEY` — required when `PLAUD_INGEST_ENABLED=true`
- `PLAUD_INGEST_ENABLED` — `true` to activate the API fetch + RAG ingest path
- `PLAUD_TIMESTAMP_SKEW_SECONDS` — replay window, default `300` (clamped to 0-3600)
- `PLAUD_ERROR_CHANNEL_ID` — optional Slack channel for `transcription.failed` notices
- `KIT_DEFAULT_WORKSPACE_ID` — workspace uuid for sessions/RAG scoping; required when ingest is enabled

### Google Calendar (briefings)
- `GOOGLE_CALENDAR_INGEST_ENABLED` — `true` to activate the 15-min cron
- `GOOGLE_SERVICE_ACCOUNT_JSON` — service-account JSON (raw or base64)
- `GOOGLE_CALENDAR_IDS` — comma-separated calendar IDs the service account has been shared into
- `BRIEFING_LEAD_TIME_MINUTES` — default `30`
- `BRIEFING_MATCH_THRESHOLD` — classifier confidence floor, default `0.5`
- `BRIEFING_DM_PRODUCER` — default `false` until project→producer mapping exists

### Delivery pipeline
- `DELIVERY_NOTIFY_CHANNEL_ID` — Slack channel id where Dropbox-detected files announce

### Studio knowledge / RAG
- `OPENAI_API_KEY` — required for embeddings (powers the entire `ask_studio_knowledge` agent + notes capture)
- `STUDIO_KNOWLEDGE_AUTO_SUMMARIZE_ENABLED` — `true` to enable the nightly Haiku re-summarization cron

### Hours check-in
- `CHECKIN_TIMEZONE` — default `America/Los_Angeles`
- `HARVEST_FREELANCER_USER_ID` — Harvest user id for the shared "freelancers" bucket account (per-freelancer time entries log against this with the artist's name in notes)

### Render workers (deployed separately on studio PCs — see `kit-render-worker/.env.example`)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — same Supabase project as Kit
- `WORKER_HOSTNAME`, `WORKER_ROLE` (`primary`|`fallback`), `WORKER_PRIORITY` (1=primary)
- `DROPBOX_SYNC_PATH` — local Dropbox sync folder
- `FFMPEG_PATH` — `ffmpeg` if on PATH, else full path
- `CPU_THRESHOLD`, `MIN_DISK_FREE_GB`, `HEARTBEAT_INTERVAL_MS`, `POLL_INTERVAL_MS`, `FALLBACK_DELAY_SECONDS`

---

## Appendix: where to look when something breaks

| Symptom | Look at |
|---|---|
| New project modal won't open | `bolt/src/handlers/interactions.ts` → `kit_open_newproject_modal` action |
| Provisioning hangs after submit | Railway logs for `[Bolt] Provisioning ...` and `Promise.allSettled` results |
| Canvas content garbled | `src/lib/mcp/slack.ts` → `preprocessCanvasHtml` + `sanitizeCanvasMarkdown` |
| Frame.io project missing folders | `FRAMEIO_TEMPLATE_PROJECT_ID` env var on Railway |
| Dropbox webhook 403 in logs | `DROPBOX_APP_SECRET` env var on Railway |
| Watcher matches path but no upload | Project's `external_ids.dropbox_safe_name` mismatch — check Supabase `projects` row |
| `no project matches safeName=...` | New project not yet in Supabase. Watcher will auto-discover from Frame.io on next file drop |
| Share link 404 | Frame.io v4 endpoint shape — see `bolt/src/watchers/dropbox.ts` share_links call |
| Storyboard "nothing happened" | Check `assistantThreadTs` is being plumbed through `updateIntake` |
