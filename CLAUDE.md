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

### Known Issues & Gotchas
- **Adobe IMS rotates refresh tokens** on each use. The auth module persists the rotation to Supabase (`frameio_token_state`) and refreshes single-flight, so restarts are safe. The env var is bootstrap-only.
- **Frame.io v4 API is relatively new** — response shapes may vary from what's documented. The code defensively checks `resp.data || resp` everywhere.
- **The v4 endpoint for project root folder** may return `root_folder_id` or `root_asset_id` — the code checks both.
- **PowerShell `curl` is aliased** to `Invoke-WebRequest` — use `Invoke-RestMethod` for API calls on Windows.
- **Sandbox network is restricted** — can't make external API calls from Cowork's bash sandbox; must be done locally or on Railway.
