# Kit Packaging — Multi-Tenant SaaS Implementation Spec

## Overview

This spec describes how to turn Kit — today a single-tenant AI production agent
built for Ranger & Fox — into a **multi-tenant SaaS product** that other studios
can buy, install, and use without any operational knowledge. The target
experience is:

1. A studio admin clicks **"Add to Slack"** from a marketing site or the Slack
   Marketplace.
2. Kit DMs them a link to a **connect screen** where they click OAuth buttons to
   link Harvest, Dropbox, and Frame.io.
3. Kit is live in their workspace. No Vercel, no Inngest, no Railway, no env
   vars, no scripts.

The customer never touches our hosting. Vercel, Inngest, Railway, and Supabase
are **our** infrastructure and stay invisible to them — the only surfaces a
customer sees are Slack and a browser-based connect/settings screen.

### Scope: what gets packaged vs. what stays a custom add-on

Not everything in Kit can be delivered as a click-to-install SaaS feature. Some
features are inherently tied to a studio's own on-premises hardware and network,
and require per-studio IT setup. Those are carved out as **optional one-off
add-ons** (custom builds, priced separately). Everything else is the
**core packaged product**.

| Capability | Packaging | Reason |
|---|---|---|
| Slack agent (chat, routing, brain, participation) | **Core** | Pure cloud, per-workspace |
| Harvest time tracking (check-ins, missing-time, logging) | **Core** | Cloud OAuth |
| Dropbox file management / provisioning | **Core** | Cloud OAuth |
| Frame.io review (comments, shares, approvals) | **Core** | Cloud OAuth |
| Project provisioning (multi-service fan-out) | **Core** | Cloud only |
| Meeting transcripts (Google Drive ingest) | **Core** | Cloud OAuth |
| Onboarding / NDA (templated per tenant) | **Core** | Cloud, needs de-branding |
| Pre-meeting briefings, delivery scans, studio-knowledge | **Core** | Cloud crons |
| **AE render farm (Deadline relay / kit-worker fleet)** | **Add-on** | On-prem Windows machines, SAN, Deadline |
| **Delivery / transcode pipeline (FFmpeg render workers)** | **Add-on** | On-prem render boxes, local Dropbox sync |
| **Watch-folder auto-submit (Dropbox → SAN farm)** | **Add-on** | Depends on the on-prem farm above |

The render/transcode farm depends on the studio's own machines, a shared SAN
(`\\thewire\production`), a Deadline license, and per-node installs — none of
which can be provisioned via an OAuth click. These ship as **paid professional
services / custom builds**, layered on top of a core tenant. The core product is
fully self-serve; the add-ons are white-glove.

---

## Current State (why this is a re-architecture, not a config change)

The **product/dashboard data layer** was scaffolded multi-tenant-ready: there is
a `workspaces` table and `workspace_id` FKs with RLS on dashboard tables
(`supabase/migrations/001_core_schema.sql`, `002_projects.sql`,
`006_studio_ops.sql`). But the **entire agent runtime is single-tenant**:

- **Credentials** are read directly from `process.env` at call time in every
  integration client (`src/lib/dropbox/client.ts`, `src/lib/frameio/auth.ts`,
  `src/lib/harvest/client.ts`, `bolt/src/app.ts:36`). One set of tokens = one
  studio.
- **Slack** is a single-workspace **Socket Mode** bot with one static bot token
  and one app-level token (`bolt/src/app.ts:36-41`). No `clientId`,
  `installationStore`, or OAuth. The incoming `team_id` is captured but never
  used to select a tenant.
- **OAuth tokens** are operator-bootstrapped env vars. Only Frame.io has an
  in-app callback (`src/app/api/auth/callback/route.ts`), and it writes a single
  global `singleton` row in `frameio_token_state`.
- **Operational tables** have **no tenant column**: `staff`, `render_jobs`,
  `render_workers`, `seen_dropbox_files`. Token tables are literal `singleton`
  rows. A single `KIT_DEFAULT_WORKSPACE_ID` is threaded through every cron/agent.
- **All backend writes use the service-role key**, which **bypasses RLS
  entirely** (`createAdminClient()`), so the existing workspace RLS protects only
  the authenticated dashboard, not the agent runtime.
- **Ranger & Fox specifics are hardcoded in source**: SAN path
  `\\thewire\production` (`bolt/src/watchers/dropbox.ts:49`), machine `AC-Slater`,
  NDA templates (`bolt/src/onboarding/nda/template.ts`, `send.ts` → `NDA_RangerFox_*`,
  `jared@rangerandfox.tv`), founder allowlist `steve@rangerandfox.tv`
  (`bolt/src/handlers/commands.ts:34`), Dropbox root `/Ranger & Fox/Production`
  (`bolt/src/onboarding/services/dropbox.ts:8`), studio-knowledge prompts, default
  timezone `America/Los_Angeles`.

Going multi-tenant means replacing every one of these single-tenant assumptions
with a per-tenant resolution. The sections below specify each.

---

## Target Architecture

```
                        ┌─────────────────────────────────────┐
                        │  Marketing site / Slack Marketplace   │
                        │         "Add to Slack" button          │
                        └───────────────────┬───────────────────┘
                                            │ OAuth v2 (install)
                                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Kit Control Plane (our infra — customer never sees it)                │
│                                                                        │
│  Next.js (Vercel)                     Bolt gateway (Railway)           │
│  ├─ /slack/install  (OAuth start)     ├─ Events API (HTTP, NOT socket) │
│  ├─ /slack/oauth_redirect (callback)  ├─ resolves tenant by team_id    │
│  ├─ /connect/:workspace (connect UI)  ├─ loads per-tenant creds        │
│  ├─ /api/oauth/:provider/{start,cb}   └─ dispatches to agent registry  │
│  ├─ /api/inngest  (multi-tenant crons)                                 │
│  └─ dashboard (per-workspace, RLS)    Inngest (fan-out per workspace)  │
│                                                                        │
│  Supabase (single project, multi-tenant, workspace_id on every table) │
│  ├─ workspaces, installations                                          │
│  ├─ integration_credentials (encrypted, per workspace+provider)        │
│  └─ all operational tables gain workspace_id                           │
└──────────────────────────────────────────────────────────────────────┘
                                            │
                     (add-on only, per studio, custom install)
                                            ▼
             ┌──────────────────────────────────────────────┐
             │  On-prem render farm (Deadline / kit-worker)   │
             │  studio SAN, Windows nodes — NOT self-serve    │
             └──────────────────────────────────────────────┘
```

Two central concepts drive everything:

1. **Tenant = Slack workspace (`team_id`).** Every inbound event, command, and
   interaction carries a `team_id`. That is the tenant key. The first thing the
   runtime does on any request is resolve `team_id → workspace` and load that
   workspace's credentials and config.
2. **A workspace's credentials live in the database, encrypted — never in
   `process.env`.** Env vars hold only *our platform* secrets (the Kit Slack app
   client ID/secret, the master encryption key, the Anthropic key, the Supabase
   service-role key), never a customer's tokens.

---

## 1. Data Model: Tenancy on Every Table

### 1.1 New tables

```sql
-- Already exists (migration 001); becomes the tenant root of truth.
-- workspaces (id uuid pk, slack_team_id text unique, name text, plan text,
--             status text, created_at, ...)

-- Slack install records (per workspace), for the OAuth installationStore.
CREATE TABLE slack_installations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slack_team_id     text NOT NULL,
  slack_enterprise_id text,
  bot_token_enc     bytea NOT NULL,      -- encrypted xoxb-
  bot_user_id       text NOT NULL,
  bot_scopes        text[],
  app_id            text NOT NULL,
  installed_by      text,                -- Slack user id of installer
  raw_installation_enc bytea NOT NULL,   -- full Bolt Installation object, encrypted
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (slack_team_id, slack_enterprise_id)
);

-- Per-workspace, per-provider integration credentials (replaces env vars).
CREATE TABLE integration_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider          text NOT NULL,       -- 'harvest' | 'dropbox' | 'frameio' | 'google'
  status            text NOT NULL DEFAULT 'connected',  -- connected | needs_reauth | revoked
  -- OAuth material, all encrypted at rest:
  access_token_enc  bytea,
  refresh_token_enc bytea,
  token_expires_at  timestamptz,
  -- provider-specific non-secret metadata (account id, workspace id, root folder):
  metadata          jsonb NOT NULL DEFAULT '{}',
  connected_by      text,                -- Slack user id
  connected_at      timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (workspace_id, provider)
);

-- Per-workspace configuration (replaces hardcoded R&F values + KIT_* singletons).
CREATE TABLE workspace_settings (
  workspace_id      uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  studio_name       text NOT NULL,        -- was "Ranger & Fox"
  timezone          text NOT NULL DEFAULT 'America/Los_Angeles',
  dropbox_root      text,                 -- was "/Ranger & Fox/Production"
  team_channel_id   text,                 -- was KIT_TEAM_CHANNEL_ID
  fallback_pm_slack_id text,              -- was KIT_FALLBACK_PM_SLACK_ID
  admin_slack_ids   text[] DEFAULT '{}',  -- replaces steve@rangerandfox.tv allowlist
  feature_flags     jsonb NOT NULL DEFAULT '{}',  -- replaces KIT_*_ENABLED envs
  branding          jsonb NOT NULL DEFAULT '{}',  -- studio name/logo/NDA cc/email
  studio_holidays   jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);
```

### 1.2 Retrofit `workspace_id` onto operational tables

These tables are currently global and must be scoped. Migration adds a nullable
`workspace_id`, backfills every existing row to the R&F workspace, then sets
`NOT NULL` and a composite index:

- `staff` — add `workspace_id`; every lookup (`bolt/src/onboarding/permissions.ts:24`
  and ~15 call sites) gains `.eq('workspace_id', ws)`.
  **Note:** `staff` is not created in the tracked migrations (it was created
  out-of-band in the R&F Supabase project). Part of this work is authoring the
  canonical `CREATE TABLE staff` migration so a fresh tenant can be provisioned
  from migrations alone.
- `render_jobs`, `render_workers`, `seen_dropbox_files` — add `workspace_id`.
  `seen_dropbox_files` dedupe key becomes `(workspace_id, dropbox_id)`;
  `render_workers.hostname` uniqueness becomes `(workspace_id, hostname)`.
- `frameio_token_state`, `dropbox_state` — drop the `singleton` row pattern; key
  by `workspace_id` (or fold into `integration_credentials`, preferred — see §4).
- Any other agent-written table (brain memory, participation state, delivery
  profiles, seen ledgers) — add `workspace_id`.

### 1.3 Enforce isolation even under service-role

The runtime writes with the service-role key, which bypasses RLS. RLS alone is
therefore **not** sufficient isolation for the agent path. Two layers:

1. **Application-level scoping (primary):** a single `tenantClient(workspaceId)`
   wrapper that every agent/handler must use instead of the raw admin client. It
   injects `workspace_id` into inserts and `.eq('workspace_id', …)` into every
   select/update/delete. Direct use of `createAdminClient()` is banned outside
   the wrapper and platform-level operations (lint rule / code review gate).
2. **RLS as defense-in-depth:** keep RLS policies on every tenant table so the
   authenticated dashboard (anon/auth key) is protected, and so a bug in the
   wrapper can't silently leak across tenants when a request uses a scoped role.

---

## 2. Per-Tenant Credential Resolution

Replace every `process.env.<PROVIDER>_*` read in the integration clients with a
lookup keyed on the current workspace.

### 2.1 Request-scoped tenant context

Introduce a `TenantContext` created at the edge of every entry point:

```ts
// src/lib/tenant/context.ts
export interface TenantContext {
  workspaceId: string;
  slackTeamId: string;
  settings: WorkspaceSettings;
  // lazily-resolved, decrypted, auto-refreshing credential accessors:
  creds: {
    slack(): Promise<SlackCreds>;
    harvest(): Promise<HarvestCreds>;
    dropbox(): Promise<DropboxCreds>;
    frameio(): Promise<FrameioCreds>;
    google(): Promise<GoogleCreds | null>;
  };
}
```

- Built once per inbound Slack event / command / interaction / cron-fanout unit.
- Threaded explicitly through the agent registry `dispatch()` and every agent
  action. This replaces the ambient `KIT_DEFAULT_WORKSPACE_ID` that is currently
  injected in `bolt/src/app.ts:295`, `brain/handler.ts`, `handlers/commands.ts`
  (6 sites), `specialist.ts:110`, and ~8 files under `src/lib/inngest/`.

### 2.2 Client refactor

Each integration client changes from module-level env reads to constructor
injection:

```ts
// before: src/lib/dropbox/client.ts
const APP_KEY = process.env.DROPBOX_APP_KEY;      // one studio

// after
export function dropboxClient(creds: DropboxCreds) { … }  // per tenant
```

Same pattern for `harvest/client.ts`, `frameio/auth.ts` + `frameio/client.ts`,
`boords/client.ts`, and the Slack `WebClient` instantiations scattered in
`bolt/src/checkins/missing-time.ts:195`, `bolt/src/delivery/spec-intake.ts:20`,
`src/lib/inngest/agents/slack.ts:21`, etc. All become
`new WebClient(await ctx.creds.slack().then(c => c.botToken))`.

### 2.3 Token refresh & rotation, per tenant

- **Frame.io / Adobe IMS**: the single-flight in-memory cache + 5-min buffer
  logic in `src/lib/frameio/auth.ts` stays, but keyed by `workspaceId` (a
  per-workspace cache map), and the rotated refresh token is persisted to
  `integration_credentials` (workspace-scoped) instead of the `singleton` row.
- **Dropbox**: today the refresh token is a static env var never rotated. Same
  refresh flow, but read/write the per-workspace credential row.
- On refresh failure (revoked/expired), set
  `integration_credentials.status = 'needs_reauth'` and have Kit DM the workspace
  admin a re-connect link (see §5). Never crash the process for one tenant's bad
  token.

---

## 3. Distributable Slack App (Socket Mode → OAuth + Events API)

This is the single largest change and the reason the current `bolt/` runtime
can't just be "flipped on" for multiple workspaces.

### 3.1 Why Socket Mode has to go

Socket Mode (`bolt/src/app.ts:36-41`) uses one app-level token and a single
persistent WebSocket bound to one workspace's bot. It is intended for internal
apps and is **not permitted for Slack Marketplace distribution**. A distributed
app must:

- Use **OAuth v2** so each workspace installs and grants its own bot token.
- Receive events over **public HTTPS endpoints (Events API)** rather than a
  socket, because there is no single bot identity to hold a socket open for.

Groundwork already exists: the Next.js side has HTTP Slack routes at
`src/app/api/webhooks/slack/events` and `/commands` verified by a signing
secret. The multi-tenant gateway builds on those rather than Socket Mode.

### 3.2 Bolt OAuth configuration

```ts
// bolt/src/app.ts (rewritten)
const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,   // our app
  clientId: process.env.SLACK_CLIENT_ID,             // our app
  clientSecret: process.env.SLACK_CLIENT_SECRET,     // our app
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: ['app_mentions:read','chat:write','commands','channels:history',
           'groups:history','im:history','im:write','users:read'],
  installationStore: supabaseInstallationStore,      // §3.3
  // HTTP receiver (Events API), NOT socketMode
});
```

### 3.3 Supabase-backed `InstallationStore`

Implements Bolt's `storeInstallation` / `fetchInstallation` / `deleteInstallation`
against `slack_installations`:

- `storeInstallation(installation)` — on install, create/find the `workspaces`
  row for `installation.team.id`, seed `workspace_settings` with defaults, and
  upsert the encrypted bot token + raw installation object.
- `fetchInstallation({ teamId, enterpriseId })` — the per-request tenant
  resolver. Returns the workspace's decrypted bot token; the gateway then builds
  the `TenantContext`.
- `deleteInstallation` — on app uninstall, mark the workspace `status='uninstalled'`
  (soft delete; retain for reinstall/billing).

### 3.4 Runtime topology change

- The **Bolt gateway** (Railway) keeps owning the long-lived process, but as an
  **HTTP Events API receiver** that resolves the tenant per event and dispatches.
- **Crons move to per-tenant fan-out** (see §6) — a single node-cron firing "5pm
  check-in for R&F" becomes "for each active workspace, enqueue a check-in job in
  that workspace's timezone."
- Interactivity/commands/events request URLs point at our public gateway;
  configured once in the app manifest, identical for all tenants.

---

## 4. Self-Serve OAuth Connect Flows

The heart of the "connect your accounts via OAuth logins and it just works"
requirement. Replaces the operator env-var bootstrap for every provider.

### 4.1 The connect screen

After install, Kit DMs the installer a link:
`https://app.getkit.tv/connect/{workspaceId}` (session-authenticated). The page
shows a card per provider — **Harvest, Dropbox, Frame.io, Google Drive
(optional)** — each with a status pill (Not connected / Connected / Needs
reauth) and a **Connect** button. The Slack connection itself is already done by
the install.

### 4.2 Generic OAuth authorize/callback

A single provider-parameterized flow at
`src/app/api/oauth/[provider]/{start,callback}/route.ts`:

- **start**: build the provider authorize URL with our platform client
  ID/secret, a `state` that encodes `{ workspaceId, provider, nonce }` (signed,
  short-TTL), and the provider's scopes. Redirect the browser.
- **callback**: verify `state`, exchange `code` → tokens, fetch provider account
  metadata (Harvest account id, Frame.io account/workspace id, Dropbox root),
  and upsert into `integration_credentials` (encrypted). Set `status='connected'`.

Per-provider specifics:

| Provider | Authorize base | Notes |
|---|---|---|
| **Frame.io / Adobe IMS** | `https://ims-na1.adobelogin.com/ims/authorize/v2` | Reuse the existing exchange logic from `src/app/api/auth/callback/route.ts`, but write per-workspace and driven by the user (not operator). Scopes per `CLAUDE.md`. Handle refresh-token rotation per §2.3. |
| **Dropbox** | `https://www.dropbox.com/oauth2/authorize` | `token_access_type=offline` for a refresh token. Replaces the `scripts/dropbox-refresh-token.ts` manual step. Capture team root namespace into `metadata`. |
| **Harvest** | `https://id.getharvest.com/oauth2/authorize` | Harvest OAuth returns account list; store chosen `HARVEST_ACCOUNT_ID` equivalent in `metadata`. Replaces static `HARVEST_ACCESS_TOKEN`. |
| **Google (Drive transcripts)** | Google OAuth consent | Optional. Replaces `GOOGLE_SERVICE_ACCOUNT_JSON`; per-tenant Drive folder id stored in `metadata`. |

Each provider must be registered as a proper OAuth app in its developer console
with our production redirect URIs — a prerequisite platform setup task, not a
per-customer one.

### 4.3 Re-auth loop

When a client hits `needs_reauth` (revoked token, rotation miss), the credential
accessor throws a typed `ReauthRequired` error; the dispatch layer catches it,
DMs the workspace admin the connect link for that provider, and returns a
friendly "I've lost access to Harvest — reconnect here" message instead of an
error.

---

## 5. Secrets Encryption

Customer tokens must be encrypted at rest, not stored plaintext (they currently
live in env vars, which is acceptable for one self-hosted studio but not for a
multi-tenant store).

- **Envelope encryption**: a master key in our secret manager
  (`KIT_MASTER_KEY`, 32-byte, from Vercel/Railway env or a KMS). Each token is
  encrypted with AES-256-GCM; the `bytea` columns store `nonce || ciphertext ||
  tag`.
- A small `src/lib/crypto/secrets.ts` module: `seal(plaintext): Buffer` /
  `open(buf): string`. All credential reads/writes go through it.
- Key rotation supported via a `key_version` byte prefix; re-encrypt lazily on
  next write.
- **Never log decrypted tokens.** Audit the existing logging in the integration
  clients for token leakage during the refactor.

---

## 6. Multi-Tenant Scheduling

Today crons are single-tenant node-cron jobs in `bolt/src/app.ts` (5pm/10pm
check-ins, 9am missing-time, hourly scavenger, per-minute AE notifier, timesheet
meme) and Inngest crons on Vercel (briefings, delivery scans, studio-knowledge,
brain, drive-transcripts).

Convert each to a **dispatcher → per-workspace fan-out** pattern:

- The scheduled trigger fires once, queries `workspaces WHERE status='active'`,
  and for each enqueues a per-workspace job (Inngest event or in-process task)
  carrying `workspaceId`.
- **Timezone correctness**: check-ins fire on the *workspace's* timezone
  (`workspace_settings.timezone`), not a single global `America/Los_Angeles`
  (`bolt/src/app.ts:255`). Either run the dispatcher hourly and select workspaces
  whose local time matches, or schedule per-timezone.
- **Feature flags per tenant**: the `KIT_*_ENABLED` env flags become
  `workspace_settings.feature_flags`; the dispatcher skips workspaces that
  haven't enabled a feature.
- **Fairness / isolation**: one tenant's slow job or bad token must not stall
  others — fan-out jobs run independently with per-job error capture.

Inngest stays as our internal orchestration engine (customer never sees it); it
simply gains `workspaceId` on every event payload.

---

## 7. De-Hardcoding Ranger & Fox

Every R&F-specific literal becomes a `workspace_settings` value or per-tenant
config. Concrete replacements:

| Hardcoded today | Location | Becomes |
|---|---|---|
| `"Ranger & Fox"` studio name | onboarding, prompts | `workspace_settings.studio_name` |
| `/Ranger & Fox/Production` Dropbox root | `bolt/src/onboarding/services/dropbox.ts:8` | `workspace_settings.dropbox_root` (or derived from Dropbox OAuth metadata) |
| `steve@rangerandfox.tv` founder allowlist | `bolt/src/handlers/commands.ts:34` | `workspace_settings.admin_slack_ids` |
| NDA template `NDA_RangerFox_*`, `jared@rangerandfox.tv`, subject line | `bolt/src/onboarding/nda/{template,send}.ts` | `workspace_settings.branding` (template + cc + from-email); templated NDA generator |
| Studio-knowledge system prompt ("Ranger & Fox's history") | `bolt/src/llm/prompts/studio-knowledge-system.ts` | Parameterized with `studio_name`; per-tenant knowledge base |
| Default timezone `America/Los_Angeles` | `bolt/src/app.ts:255` | `workspace_settings.timezone` |
| `KIT_TEAM_CHANNEL_ID`, `KIT_FALLBACK_PM_SLACK_ID`, etc. | env, threaded everywhere | `workspace_settings` columns |
| Supabase project id `ozsxrcgrezpffnpwlrnq` | docs only | N/A (single shared project) |
| `\\thewire\production`, `AC-Slater` | render-farm code/docs | **Add-on config**, not core (see §9) |

A `settings/workspace` dashboard page already exists
(`src/app/(app)/settings/workspace/page.tsx`) and becomes the surface for admins
to edit these.

---

## 8. Onboarding & Billing

- **Install → provision**: `storeInstallation` creates the workspace + default
  settings. A welcome DM links to the connect screen (§4.1) and a short setup
  checklist (connect Harvest/Dropbox/Frame.io, set timezone, name your studio,
  designate admins).
- **Staff sync**: `/kit sync-staff` (already exists) runs per workspace after
  Harvest is connected, writing workspace-scoped `staff` rows.
- **Billing**: add Stripe (or Slack Marketplace billing). A `workspaces.plan` /
  `status` gate wraps dispatch — expired/unpaid tenants get a friendly upgrade
  DM instead of service. Metering hooks: active staff count, render minutes (for
  add-on customers).
- **Data deletion / offboarding**: on uninstall or cancellation, a retention
  window then hard-delete of the workspace cascade (`ON DELETE CASCADE` from
  `workspaces`).

---

## 9. Add-On: Render / Transcode Farm (custom build, not self-serve)

The AE render farm, delivery/transcode pipeline, and Dropbox watch-folder
auto-submit stay **out of the core SaaS** because they require the studio's own
on-prem infrastructure:

- On-prem Windows render nodes with AE 2026 render engine / FFmpeg installed.
- A shared SAN (`\\thewire\production`) reachable by all nodes.
- Either the `kit-worker` fleet or an existing **Deadline** farm + the
  `kit-deadline-relay` box.
- Per-node config: `AERENDER_PATH`, `DROPBOX_SYNC_PATH`, `AE_FARM_UNC_ROOT`,
  `RENDER_BACKEND`, `DEADLINE_PATH_MAP`, etc.

**Packaging as an add-on:**

- The render tables (`render_jobs`, `render_workers`, `seen_dropbox_files`) still
  gain `workspace_id` (§1.2) so the *cloud* side is multi-tenant-ready, but the
  worker/relay installs are delivered as a **paid professional-services
  engagement** per studio.
- A per-workspace `feature_flags.render_farm = true` unlocks `/kit render`, the
  delivery agent actions, and the watch-folder watcher for that tenant.
- The worker apps authenticate to our backend with a **per-workspace worker
  token** (not the shared `KIT_MCP_SECRET`, which also must become
  per-workspace) so a studio's render nodes only ever claim that studio's jobs.
- Studio-specific paths/machine names (`\\thewire`, `AC-Slater`) move from source
  into the add-on's per-install config, never the core codebase.

This lets the core product ship fully self-serve while the farm remains a
high-touch, higher-margin custom offering for studios that want it.

---

## 10. Phased Delivery Plan

Ordered so each phase is shippable and de-risks the next.

**Phase 0 — Platform prerequisites**
- Register the Kit Slack app for distribution (OAuth, public request URLs).
- Register OAuth apps for Harvest, Dropbox, Frame.io/Adobe, Google with prod
  redirect URIs.
- Provision the shared multi-tenant Supabase project + `KIT_MASTER_KEY`.

**Phase 1 — Tenancy foundation (no behavior change for R&F)**
- Add `slack_installations`, `integration_credentials`, `workspace_settings`.
- Retrofit `workspace_id` onto `staff`, `render_*`, `seen_dropbox_files`, token
  tables; author the canonical `staff` migration; backfill R&F.
- Build `secrets.ts`, `TenantContext`, and `tenantClient(workspaceId)`.
- Migrate R&F's existing env-var credentials into `integration_credentials` and
  config into `workspace_settings` (R&F becomes tenant #1 of the new system).

**Phase 2 — Distributable Slack**
- Rewrite `bolt/src/app.ts` to OAuth + Events API + Supabase `installationStore`.
- Refactor all `WebClient`/`app.client` uses to resolve per-tenant bot tokens.
- Verify R&F still works end-to-end through the new HTTP path.

**Phase 3 — Per-tenant credentials & connect UI**
- Refactor every integration client to constructor-injected creds.
- Build the generic OAuth `[provider]/{start,callback}` routes and connect screen.
- Wire the re-auth loop.

**Phase 4 — Multi-tenant crons & de-branding**
- Convert all crons to dispatcher → per-workspace fan-out with per-tenant
  timezone + feature flags.
- Replace every hardcoded R&F literal (§7) with `workspace_settings`.
- Templatize NDA/onboarding/studio-knowledge.

**Phase 5 — Onboarding, billing, hardening**
- Welcome flow, setup checklist, Stripe/Marketplace billing, offboarding.
- Security review: tenant isolation tests, no cross-tenant leakage, token
  encryption audit, rate limiting per workspace.

**Phase 6 — Render farm add-on (optional, per customer)**
- Per-workspace worker tokens, `feature_flags.render_farm`, install docs, and a
  professional-services runbook.

---

## 11. Security & Isolation Checklist

- [ ] No customer token ever stored plaintext; all through `secrets.ts`.
- [ ] Every operational query scoped by `workspace_id` via `tenantClient`.
- [ ] Direct `createAdminClient()` use banned outside platform ops (lint/CI gate).
- [ ] RLS retained on all tenant tables as defense-in-depth.
- [ ] Slack `state` params signed + short-TTL; OAuth `state` bound to workspace.
- [ ] Per-workspace worker/MCP tokens (retire the single shared `KIT_MCP_SECRET`).
- [ ] Cross-tenant isolation test suite (tenant A can never read/write tenant B).
- [ ] Per-workspace rate limiting so one tenant can't exhaust shared quotas
  (Anthropic, provider APIs).
- [ ] Decrypted tokens never logged; audit integration-client logging.
- [ ] Uninstall/cancel → retention window → cascade delete verified.

---

## 12. Open Questions

1. **Anthropic key model** — one platform key metered per workspace, or
   bring-your-own-key per studio? (Affects margin + rate limiting.)
2. **Slack Marketplace vs. direct distribution** — Marketplace gives discovery +
   billing but adds a review bar; direct "Add to Slack" is faster to ship.
3. **Dropbox scope** — team-wide app vs. per-user; affects the folder-root model
   and admin consent.
4. **Frame.io v4 tenancy** — confirm one Adobe OAuth app can serve many Frame.io
   accounts via per-workspace refresh tokens (expected, but verify against the
   IMS app model).
5. **Data residency** — any studios needing EU/region isolation would force a
   sharded-project model rather than one shared Supabase project.
6. **R&F cutover** — run R&F as tenant #1 on the new stack (recommended, dogfood)
   vs. keep the legacy single-tenant deploy until the SaaS is proven.

---

## Appendix: File-Level Change Map

| Area | Files touched |
|---|---|
| Slack OAuth/gateway | `bolt/src/app.ts`, new `bolt/src/slack/installation-store.ts`, `src/app/api/webhooks/slack/{events,commands}` |
| Tenant context | new `src/lib/tenant/context.ts`, `src/lib/tenant/client.ts`; `src/lib/inngest/agents/registry.ts` (`dispatch` signature) |
| Credential clients | `src/lib/dropbox/client.ts`, `src/lib/frameio/{auth,client}.ts`, `src/lib/harvest/client.ts`, `src/lib/boords/client.ts`, `bolt/src/llm/client.ts` |
| OAuth connect | new `src/app/api/oauth/[provider]/{start,callback}/route.ts`, new `src/app/connect/[workspace]/page.tsx`; retire `src/app/api/auth/callback/route.ts` operator flow |
| Crypto | new `src/lib/crypto/secrets.ts` |
| Migrations | new tables + `workspace_id` retrofits + canonical `staff` table under `supabase/migrations/` |
| Crons | `bolt/src/app.ts` schedules, `src/app/api/inngest/route.ts`, all fns under `src/lib/inngest/` |
| De-branding | `bolt/src/onboarding/**`, `bolt/src/handlers/commands.ts`, `bolt/src/llm/prompts/**`, `bolt/src/watchers/dropbox.ts` |
| Settings UI | `src/app/(app)/settings/workspace/page.tsx` |
| Add-on gating | `render_*` migrations, `bolt/src/delivery/**`, `bolt/src/watchers/dropbox.ts`, worker/relay auth |
