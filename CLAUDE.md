# Kit — AI Production Agent for Ranger & Fox

## What Kit Is

Kit is an AI-powered production management agent for Ranger & Fox, a creative studio. It lives in Slack (via Bolt SDK + Socket Mode) and orchestrates project provisioning, time tracking, file management, and video review across multiple SaaS tools: Slack, Harvest, Dropbox, Frame.io, and Supabase.

## Architecture

### Agent Registry Pattern
Kit uses a domain-expert agent system. Each integration has its own agent that knows everything about its service. A routing layer dispatches natural language requests to the right agent based on intent detection.

- **Agents**: `src/lib/inngest/agents/` — Harvest, Dropbox, Frame.io, Slack
- **Agent types**: `src/lib/inngest/agents/types.ts`
- **Provisioner**: `src/lib/provisioner/` — orchestrates multi-service project creation
- **Access control**: Three-tier (admin/producer/artist) with gateway + field-level filtering

### Slack Bolt App
- **Entry point**: `bolt/src/app.ts`
- **Handlers**: `bolt/src/handlers/` — messages.ts, commands.ts, interactions.ts
- **Socket Mode**: persistent WebSocket, no webhooks, no timeout concerns
- **Deployment**: Railway (always-on Node.js process via Dockerfile)

### Key Integrations
| Service | Auth Method | Status |
|---------|------------|--------|
| Slack | Bot Token + App-Level Token (Socket Mode) | ✅ Working |
| Harvest | Access Token + Account ID | ✅ Working |
| Dropbox | OAuth refresh token flow | ✅ Working |
| Frame.io | Adobe IMS OAuth (v4 API) | 🔧 Code migrated, needs testing |
| Supabase | Service Role Key | ✅ Working |

---

## Current State & What Needs Doing

### 1. Deployment topology (CURRENT)
- **Railway** runs the Bolt app (Socket Mode bot + node-cron jobs: 5pm/10pm
  check-ins, 9am missing-time scan, hourly scavenger DM dispatch) from `main`
  via `bolt/Dockerfile` (config: repo-root `railway.toml`, health probe at
  `/health`).
- **Vercel** runs the Next.js app + ALL Inngest cron functions
  (`src/app/api/inngest/route.ts`): pre-meeting briefings, delivery scans,
  Plaud, studio-knowledge, brain. Deploys from `main`. Inngest must stay
  synced (Vercel integration) or every cron silently stops.
- **Supabase** project `ozsxrcgrezpffnpwlrnq` ("Kit"). Migrations under
  `supabase/migrations/` are applied via the Supabase MCP `apply_migration`.
- Env manifests: `bolt/.env.example` (Railway side), root `.env.example`
  (Vercel side). Several credentials must be set in BOTH dashboards.

### 2. Frame.io v4 API — LIVE
Migrated to v4 (Adobe IMS OAuth) and confirmed working in production. The
rotated refresh token is persisted in `frameio_token_state` (Supabase), so
restarts no longer lose the rotation. Old v2 vars (`FRAMEIO_TOKEN`,
`FRAMEIO_ROOT_PROJECT_ID`) can be removed from Railway.

**v4 API key differences from v2:**
- Base URL: `https://api.frame.io/v4` (was `/v2`)
- All paths prefixed with `/accounts/{account_id}/`
- "teams" → "workspaces", "assets" → "files/folders", "review_links" → "shares"
- Request bodies wrapped in `{ data: { ... } }`, responses in `{ data: ... }`

### 3. Dormant features awaiting data/setup (not code)
- **Time tracking** (5pm check-in, missing-time monitor, ad-hoc logging):
  requires `staff.harvest_user_id` — run `/kit sync-staff` (admin) after
  adding people to Harvest.
- **Briefing "Last meeting" recap**: requires Plaud transcripts flowing
  (`PLAUD_INGEST_ENABLED`).
- **Delivery pipeline**: requires the render worker (kit-render-worker/)
  installed on at least one studio PC.

### 4. Slack App Configuration
Verify these are set in the Slack app settings (api.slack.com):
- **Socket Mode**: Enabled
- **App-Level Token**: Generated with `connections:write` scope → set as `SLACK_APP_TOKEN` on Railway
- **Bot Token Scopes**: `app_mentions:read`, `chat:write`, `commands`, `channels:history`, `groups:history`, `im:history`, `im:write`, `users:read`
- **Slash command**: `/kit` registered pointing to the app
- **Event subscriptions**: `app_mention`, `message.im`

---

## File Map

### Core Agent System
```
src/lib/inngest/agents/
├── types.ts          — AgentDefinition, AgentResult interfaces
├── registry.ts       — Agent registry + dispatch()
├── harvest.ts        — Time tracking agent
├── dropbox.ts        — File management agent
├── frameio.ts        — Video review agent (v4 API)
└── slack.ts          — Channel/user management agent
```

### Frame.io Integration
```
src/lib/frameio/
├── auth.ts           — Adobe IMS OAuth token refresh (caches in memory)
└── client.ts         — v4 API client (comments, assets, shares, thumbnails)
```

### Provisioner (Multi-Service Project Creation)
```
src/lib/provisioner/
├── types.ts              — ProjectIntakeForm, ServiceResult
├── folder-structure.json — Standard folder templates per service
├── modal.ts              — project intake modal definition
└── retry.ts              — withRetry() utility
```
(Per-service provisioning lives on each agent in src/lib/inngest/agents/ —
the old provisioner/services/ directory is gone.)

### Dropbox Integration
```
src/lib/dropbox/
└── client.ts         — OAuth refresh token flow (already working)
```

### Slack Bolt App
```
bolt/
├── src/
│   ├── app.ts            — Entry point, registers handlers
│   └── handlers/
│       ├── messages.ts   — app_mention + DM handling, intent detection
│       ├── commands.ts   — /kit slash command (newproject, status, help)
│       └── interactions.ts — Modal submissions (project provisioning)
├── Dockerfile            — Node 20, copies bolt/ + src/lib/
├── railway.toml          — Always-on deployment config
├── package.json
├── tsconfig.json
└── .env.example          — All required env vars documented
```

---

## Auth Flows

### Dropbox — OAuth Refresh Token
- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`
- Client at `src/lib/dropbox/client.ts` handles automatic refresh
- Tokens never expire (refresh tokens are long-lived)

### Frame.io — Adobe IMS OAuth
- `FRAMEIO_ADOBE_CLIENT_ID`, `FRAMEIO_ADOBE_CLIENT_SECRET`, `FRAMEIO_ADOBE_REFRESH_TOKEN`
- Auth module at `src/lib/frameio/auth.ts`
- Access tokens expire in ~1 hour, auto-refreshed with 5-min safety buffer
- **Important**: Adobe rotates refresh tokens on each use. The auth module handles this in-memory, but if the process restarts, it falls back to the env var token. If that token has been rotated, re-authorization is needed.
- Scopes: `offline_access, openid, email, profile, AdobeID, additional_info.roles`
- Adobe IMS token endpoint: `https://ims-na1.adobelogin.com/ims/token/v3`
- Fallback: if `FRAMEIO_TOKEN` is set and Adobe creds aren't, uses static developer token with v4 API

### Harvest — Static Token
- `HARVEST_ACCESS_TOKEN`, `HARVEST_ACCOUNT_ID`
- Simple bearer token auth

---

## Environment Variables (Complete List)

```env
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Harvest
HARVEST_ACCESS_TOKEN=
HARVEST_ACCOUNT_ID=

# Dropbox (OAuth refresh flow)
DROPBOX_APP_KEY=
DROPBOX_APP_SECRET=
DROPBOX_REFRESH_TOKEN=

# Frame.io v4 (Adobe IMS OAuth)
FRAMEIO_ADOBE_CLIENT_ID=
FRAMEIO_ADOBE_CLIENT_SECRET=
FRAMEIO_ADOBE_REFRESH_TOKEN=
FRAMEIO_ACCOUNT_ID=
FRAMEIO_WORKSPACE_ID=

# Anthropic (for Kit's AI routing)
ANTHROPIC_API_KEY=
```

---

## Testing Provisioning

Once deployed, test from Slack:
1. Type `/kit newproject` — should open a modal
2. Fill in client name, project name, etc.
3. Submit — Kit should DM progress updates as it provisions across Slack, Dropbox, Harvest, and Frame.io
4. Verify Frame.io project appears at `https://app.frame.io` with the standard folder structure

## Tech Stack
- **Runtime**: Node.js 20
- **Slack**: Bolt SDK 4.7+ with Socket Mode
- **Database**: Supabase (PostgreSQL)
- **Deployment**: Railway (Bolt app), Vercel (Next.js frontend)
- **Language**: TypeScript

---

## Session History — What Was Built

Everything below was designed and built across two Cowork sessions (May 2026). This is the full build log for context continuity.

### Phase 1: Agent System Architecture
1. **Designed the agent orchestrator architecture** — domain-expert agents with a central registry and dispatch pattern, replacing a monolithic approach
2. **Built Harvest agent as proof of concept** — first agent with full CRUD (create project, list projects, log time, get entries)
3. **Set up Inngest** for background job orchestration (later removed in favor of direct execution in Bolt handlers to avoid timeout complexity)
4. **Refactored `kit_create_project`** to use the orchestrator pattern with `Promise.allSettled` for parallel provisioning
5. **Verified architecture end-to-end** — confirmed the agent dispatch pattern works

### Phase 2: Full Agent Expert System
6. **Designed agent expert system with capability registry** — each agent declares its capabilities, required env vars, and whether actions mutate state
7. **Expanded Harvest Agent** — full domain expert with time entry search, project budgets, weekly summaries
8. **Expanded Slack Agent** — channel creation, user lookup, message posting, channel archival
9. **Expanded Dropbox and Frame.io Agents** — file management, folder creation, review comments, approval status
10. **Built Kit routing layer** — keyword-based intent resolver that maps natural language to agent actions
11. **Designed three-tier access control** — admin/producer/artist roles with gateway + field-level filtering

### Phase 3: Slack Bolt App
12. **Created Bolt app entry point** (`bolt/src/app.ts`) — Socket Mode, registers all handlers
13. **Built message handler** (`bolt/src/handlers/messages.ts`) — app_mention + DM events, Frame.io link detection, time entry parsing, dispatches to agent registry
14. **Built command handler** (`bolt/src/handlers/commands.ts`) — `/kit` slash command with subcommands: newproject (opens modal), status (project lookup), help
15. **Built interaction handler** (`bolt/src/handlers/interactions.ts`) — `kit_provision_project` modal submission, creates project in Supabase, fans out to all agents via `Promise.allSettled`, streams DM progress updates, posts summary to project channel
16. **Set up Railway deployment config** — Dockerfile (Node 20, copies bolt/ + src/lib/), railway.toml (always-on, single replica)

### Phase 4: Auth & Integration Fixes
17. **Fixed Dropbox token expiration** — the old 4-hour access tokens didn't scale. Discovered the OAuth refresh token flow was already built in `src/lib/dropbox/client.ts`, just needed `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` configured. Walked through the full OAuth authorization code exchange to get the refresh token.
18. **Fixed Frame.io authentication** — migrated from static developer tokens to Adobe IMS OAuth:
    - Created OAuth Web App credential in Adobe Developer Console
    - Added Frame.io API as a connected service
    - Scopes: `offline_access, openid, email, profile, AdobeID, additional_info.roles`
    - Built `src/lib/frameio/auth.ts` — Adobe IMS refresh token flow with in-memory caching and 5-min safety buffer
    - Completed full OAuth authorization code exchange
    - Confirmed auth works: `GET /v4/me` and `GET /v4/accounts` return successfully
19. **Migrated Frame.io from v2 to v4 API** — complete rewrite of three files:
    - `src/lib/frameio/client.ts` — all endpoints migrated (teams→workspaces, assets→files/folders, review_links→shares), response unwrapping for `{ data: ... }` format
    - `src/lib/inngest/agents/frameio.ts` — agent uses v4 paths, env vars updated to FRAMEIO_ACCOUNT_ID + FRAMEIO_WORKSPACE_ID
    - `src/lib/provisioner/services/frameio.ts` — provisioner creates projects under workspaces, folders under parent folders, request bodies wrapped in `{ data: { ... } }`

### Phase 5: Deployment (In Progress)
20. **Railway env vars configured** — all 17 service variables set including Frame.io v4 credentials
21. **Git push blocked** — local git authenticated as `stevepanicara`, repo owned by `steve-rangerandfox`. Needs PAT or collaborator access to push.
22. **Embedded git worktree staged accidentally** — `.claude/worktrees/gracious-darwin-f9a5b7` needs `git rm --cached` and `.claude/worktrees/` added to `.gitignore`

### Phase 6: Delivery Pipeline (Next Up)
23. **Full spec written** — see `DELIVERY-PIPELINE-SPEC.md` in repo root for the complete implementation spec
24. **What it is**: Distributed video transcoding system. Drop files in Dropbox → Kit prompts for delivery specs in Slack → FFmpeg render workers transcode to broadcast specs (ProRes, loudness normalization, channel mapping, naming conventions)
25. **Key components**: Delivery agent in Kit, Supabase job queue (3 new tables), standalone render worker app (Node.js) installed on studio PCs, FFmpeg command builder
26. **Architecture**: Primary render box claims jobs instantly, fallback workers (editor workstations) auto-claim after 30s timeout. Workers heartbeat to Supabase, stale workers get their jobs reassigned.
27. **All machines are Windows PCs** — ProRes via FFmpeg `prores_ks` software encoder

### Phase 7: After Effects Render Farm
28. **Full spec written** — see `AE-RENDER-FARM-SPEC.md` in repo root.
29. **What it is**: Renders an AE project across every studio machine, driven by the project's *own render queue*. `/kit render` opens a modal whose only field is the `.aep` Dropbox path — no comp/frames/fps. Kit reads the project's After Effects render queue and renders every queued item with its existing render settings + output module, frame-split across the fleet.
30. **Reuses the delivery pipeline farm** — same `render_jobs`/`render_workers` tables, atomic claim, primary/fallback failover, heartbeats, worker app. Migration `032` adds a `job_type` discriminator + AE/chunk columns + `ae_capable`/`aerender_path` on workers; `033` adds the `ae_inspect` type, `ae_rqindex`/`ae_is_movie`, and `render_queue` jsonb.
31. **Job model**: one `ae_render` parent (tracker) → one `ae_inspect` job (AE worker scripts `AfterFX.exe` to dump the render queue, then inserts the chunks) → N `ae_chunk` rows (image-sequence items frame-split; single-movie items rendered whole; claimed only by AE-capable workers) → optional `ae_stitch` (only when a delivery profile is attached). Finalize via an atomic lock on the parent's `claimed_by` sentinel.
32. **Honors project settings**: chunks render with `aerender -rqindex <n>` so each item's render settings + output module are exactly what the artist queued; `-output` is redirected to a shared Dropbox folder (`<projectDir>/render/<comp>/`) because a project's absolute output path can't resolve across machines.
33. **New code**: worker `src/aerender/*` (incl. `inspect-script.ts`/`inspect-runner.ts`) + `src/ae-processor.ts`; Kit `src/lib/delivery/frame-planner.ts` + `ae-storage.ts` (`submitAeRenderFromProject`); `delivery` agent actions `render_project`/`submit_ae_render`/`ae_render_status`/`list_ae_renders`; `/kit render` modal (`bolt/src/delivery/render-modal.ts`).
34. **Licensing for "every computer"**: install the free **After Effects Render Engine** (render-only, no CC seat) on each PC via the Creative Cloud app. Set `AERENDER_PATH` in the worker `.env` (installer auto-detects; `AfterFX.exe` for queue inspection is derived as its sibling).
35. **Biggest gotchas**: queue the comps in the project first (only QUEUED items render); consistent footage paths across nodes (Dropbox sync or Collect Files); plugins/fonts on every node; app scripting must be allowed on render nodes (for `ae_inspect`); temporal-dependency effects (motion blur / frame blending) can seam at chunk boundaries — keep those as a single movie output so they render whole.
36. **Pluggable backend (`RENDER_BACKEND`)**: default `kit-worker` (our fleet). Set `RENDER_BACKEND=deadline` to submit to an existing Thinkbox/AWS **Deadline** farm instead — no per-box worker needed. Migration `034` adds `render_backend` + `deadline_jobs` to `render_jobs`; `submitAeRenderFromProject` skips `ae_inspect` for the Deadline path. The `kit-deadline-relay/` app (one studio box with `deadlinecommand` + After Effects) claims the parent, reads the render queue, submits one Deadline AE job per queued comp (`deadlinecommand -SubmitJob`; image seq → `ChunkSize` split, movie → whole), and polls `-GetJob` to roll status back to `/kit render status`. Files live on the production SAN `\\thewire\production\<year>\<jobcode>\...` (same as C4D, in an AE folder) — **not Dropbox**. `/kit render` takes the SAN path (`\\thewire\production\...` or `Z:\...`); the relay passes it straight to Deadline `SceneFile` and writes output to `<projectDir>\render\<comp>\`. `DEADLINE_PATH_MAP` only normalizes drive letters to UNC (`Z:=>\\thewire\production`) for headless Workers. Studio farm is `\\thewire\deadline` (Deadline 10.2.1.1, pools none/c4d/test, groups none/c4d_render). **The C4D setup is production-critical and must NOT be altered — the AE integration is strictly additive and the relay is submit-only (never runs admin/config commands).** AE jobs target a dedicated group (`DEADLINE_GROUP=kit_ae`) and plugin (`DEADLINE_PLUGIN=KitAfterEffects`). Studio runs **AE 2026 (v26)**; the stock `AfterEffects.py` builds the exe key dynamically (`RenderExecutable26_0`), so v26 works once that entry exists — add it via a `KitAfterEffects` custom plugin overlay (`custom/plugins/`, zero-touch to stock/C4D) and submit `AE_VERSION=26.0`. Every AE render node needs AE 2026 installed.
37. **Watch folder (auto-submit)**: every project's `08_AE/03_RenderFarm/` is a render watch folder. The `/production` Dropbox webhook watcher (`bolt/src/watchers/dropbox.ts`) matches `.aep` drops there as soon as they sync, translates to the SAN path (`AE_FARM_UNC_ROOT`, default `\\thewire\production`), and calls `submitAeRenderFromProject`. Dedupe on Dropbox `id@rev` (ledger keys `aefarm:` in `seen_dropbox_files`) — each saved revision renders once; re-saves re-render; conflicted copies + `__kitfarm.aep` farm copies skipped. A per-minute Bolt cron (`src/lib/delivery/ae-notify.ts`) announces complete/failed (with per-comp output paths) in the project channel, idempotent via `slack_notified_status`.
38. **Spec follow-up (render → delivery pipeline)**: the render-complete notice carries an *Add delivery specs* button (`kit_ae_add_specs` in `bolt/src/delivery/submit-handler.ts`). Clicking it opens a spec-intake thread on that message (reuses `delivery_spec_intake` + `handleSpecIntakeReply`): reply with the spec as text/PDF/screenshot; extra files join via `audio: <path>` lines or bare `/production/...wav` paths (`extractAudioPathsFromText`). The extracted spec becomes a profile + transcode job whose source is the assembled render (UNC→Dropbox via `uncToDropboxPath`), and the deliverable lands **next to the source** (`render/<comp>/`) — `delivery_spec_intake.output_dir` (migration 035) → `render_jobs.ae_output_dir` → worker output-dir override. Requires a kit-render-worker with `DROPBOX_SYNC_PATH` covering `/production`.
39. **Prepare + assemble (Deadline renders sequences only)**: the relay's prepare step (AfterFX script) captures each queued item's real output module (e.g. ProRes 422 .mov), overrides it to a **PNG sequence** so Deadline can frame-split, queues a **WAV duplicate** for audible comps, and saves `<name>__kitfarm.aep` (artist's file untouched; aerender `-comp` renders the first queued instance, so the audio dup is never farm-rendered). Frames render to `render\<comp>\frames\`; the relay renders audio locally, then on Deadline completion **assembles** with FFmpeg to the original format at the comp's fps (`assemble.ts` codec sniff: ProRes 422/HQ/LT/Proxy/4444, H.264; default ProRes 422), muxes the WAV (`-shortest`), writes the artist's filename into `render\<comp>\`, deletes frames (`AE_KEEP_FRAMES=false`). If the OM can't be forced to a sequence, that comp falls back to a whole-movie render (no split/assemble). Relay box needs FFmpeg (`FFMPEG_PATH`). Untested-on-farm bits to verify first run: `om.getSettings`/`setSettings({"Format":"PNG Sequence"})` and `{"Format":"WAV"}` in AE 2026, and Deadline status parsing.

### Known Issues & Gotchas
- **Adobe IMS rotates refresh tokens** on each use. The auth module persists the rotation to Supabase (`frameio_token_state`) and refreshes single-flight, so restarts are safe. The env var is bootstrap-only.
- **Frame.io v4 API is relatively new** — response shapes may vary from what's documented. The code defensively checks `resp.data || resp` everywhere.
- **The v4 endpoint for project root folder** may return `root_folder_id` or `root_asset_id` — the code checks both.
- **PowerShell `curl` is aliased** to `Invoke-WebRequest` — use `Invoke-RestMethod` for API calls on Windows.
- **Sandbox network is restricted** — can't make external API calls from Cowork's bash sandbox; must be done locally or on Railway.
