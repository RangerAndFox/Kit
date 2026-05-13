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
9. [Infrastructure](#9-infrastructure)
10. [Environment variables](#10-environment-variables)

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
2. User submits → form fields parsed → project row inserted into Supabase `projects` table
3. `Promise.allSettled` fans out to each selected service via `dispatch(service, 'provision', payload)` from `src/lib/inngest/agents/registry.ts`
4. Each progress update is `chat.postMessage`-ed back into the originating thread via the `postOpts({thread_ts})` helper
5. Final `external_links` and `status='active'` updated on the project row
6. Summary card posted in the new project's Slack channel

**Key files**
- `bolt/src/handlers/interactions.ts` — the orchestrator
- `src/lib/provisioner/modal.ts` — modal block kit definition
- `src/lib/inngest/agents/*.ts` — per-service provisioning logic
- `src/lib/provisioner/slack-summary.ts` — final summary card

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
For each new project, Kit creates a Slack channel (`#{number}-{client}-{name}`), invites the PM + team members, sets the topic, posts a welcome message, and clones every canvas tabbed to the **template channel** (`C0B1312H89L`) into the new channel — both the channel's header-anchored canvas and any standalone canvases. Producers maintain templates by editing them in the template channel; no env-var changes needed.

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

## 9. Infrastructure

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

## 10. Environment variables

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
