# Runtime boundaries

Where Kit's code runs, what triggers it, and what is verifiable from the repo
versus reported. **Verify ownership here before moving work across a boundary.**

Facts about dashboards (Railway/Vercel settings, actual deployed branch, env
values) are **not** visible in the repository. Anything below not backed by a
committed file is labelled `Needs verification` and must not be asserted as
fact.

## Railway — persistent Slack Bolt service

- **Responsibility:** the always-on Slack bot (Socket Mode, outbound
  WebSocket) plus in-process `node-cron` scheduled jobs.
- **Entry point:** `bolt/src/app.ts`, launched via `npx tsx src/app.ts`
  (`bolt/Dockerfile` `CMD`). *(Verified.)*
- **Process lifetime:** long-lived. `railway.toml`: `numReplicas = 1`,
  `restartPolicyType = "ALWAYS"`, `sleepApplication = false`. *(Verified.)*
- **Build source:** Dockerfile build, `dockerfilePath = "bolt/Dockerfile"`,
  context is repo root (to include `src/lib/`). *(Verified.)*
- **Runtime:** `node:20-slim`. *(Verified in `bolt/Dockerfile`.)*
- **Health mechanism:** container `HEALTHCHECK` and `railway.toml`
  `healthcheckPath = "/health"` probe the app's real `/health` endpoint
  (Slack-connectivity watchdog), default `PORT` 3001. *(Verified.)*
- **Which branch deploys:** *Needs verification* — not encoded in the repo.
- **Recovery sweeps run here:** `runProjectControlRecoverySweep`
  (`bolt/src/handlers/interactions.ts`, node-cron) recovers BOTH stalled project
  *creation* and stalled project *update* ripples (`recoverUpdateRipples` +
  `project_update_requests`/`project_update_steps`, migration 063). Both are
  idempotent (reconcile-by-marker + memoized durable steps), so a resumed ripple
  never double-applies. *(Verified in code; live cadence Needs verification.)*
- **node-cron jobs run here:** *Needs verification* — in-process `node-cron`
  schedules are configured in `bolt/src/app.ts` but were not inspected this
  sprint. Read `app.ts` to confirm any specific schedule before relying on it.

## Vercel — Next.js app + Inngest functions

- **Responsibility:** the Next.js web app (`/status` and API routes) and all
  registered Inngest cron/background functions.
- **Entry point (web):** `src/app/`. **Entry point (crons):**
  `src/app/api/inngest/route.ts` — `serve()` registers the functions.
  *(Verified.)*
- **Registered functions (Verified from `route.ts`):** `preMeetingScan`,
  `preMeetingDispatch`, `deliveryDropboxScan`, `deliverySpecsScan`,
  `deliveryJobNotifier`, `deliveryStaleSweep`, `studioKnowledgeAutoSummarize`,
  `brainDeadlineSweep`, `brainScavengerScan`, `brainConsolidate`,
  `driveTranscriptScan`, `healthWatchdog`, `healthDailyDigest`,
  `projectControlSync`, `projectControlSyncOnEdit`.
- **`healthDailyDigest` (Verified from `route.ts`):** daily 09:00 America/New_York
  cron (`TZ=`-pinned) that runs the same `runAllChecks()` as the watchdog, rolls
  up `daily_hours_checkins` state, and DMs a one-glance digest to the studio
  owner from Kit's bot (`chat.postMessage`, `SLACK_BOT_TOKEN`). Unlike the
  transition-only watchdog it always sends. Recipient defaults in code and is
  overridable via `KIT_HEALTH_DIGEST_USER_ID`. Inside the fail-closed
  `selectRegisteredFunctions` boundary like every other function.
- **Project Control Sheet → Canvas sync (Verified):** two Inngest functions that
  run the SAME `runProjectControlSync` core (`src/lib/inngest/project-control-sync.ts`),
  both gated on `PROJECT_CONTROL_SYNC_ENABLED`:
  - **`projectControlSync`** — the ten-minute cron (`*/10`); the authoritative
    one-way Master Project List → Canvas convergence/recovery path (also the only
    path that catches API/script-originated Sheet changes). It owns the workbook
    Drive-version cursor + sync lease.
  - **`projectControlSyncOnEdit`** — triggered by the authenticated
    `project-control/sheet.edited` event (from the Sheet-edit webhook →
    `inngest.send`), giving a near-immediate refresh after a human Master Project
    List edit. Debounced per workbook + idempotent per `request_id`; it delegates
    to the same core, so it reuses the same lease, row-hash, cursor, and Canvas
    identity — no second sync implementation.
  Both are registered INSIDE the fail-closed `selectRegisteredFunctions`
  boundary (see below), so a Vercel Preview deployment registers **zero**
  functions — including the event refresh — unless it sets the exact
  `KIT_INNGEST_ALLOW_PREVIEW=true` opt-in. The *creation-side* binding (Sheet row
  + Canvas) runs on **Railway** inside the provisioner
  (`src/lib/project-control/creation.ts`), gated on
  `PROJECT_CONTROL_CREATION_ENABLED` — a separate control. All reuse the
  `GOOGLE_SERVICE_ACCOUNT_JSON` service account (raw REST; googleapis is not in
  the Bolt image).
- **Trigger model:** Inngest invokes functions on their schedules/events. A
  function must be listed in `route.ts` *and* synced to Inngest to run.
  *(`route.ts` list is Verified; the Inngest sync state is Needs verification.)*
- **Only production may register scheduled functions.** The app id is a constant
  (`kit`) and the Inngest environment is chosen solely by the injected
  `INNGEST_SIGNING_KEY` / `INNGEST_EVENT_KEY`; there is no `INNGEST_ENV`. So any
  deployment holding the production keys joins the **production** Inngest
  environment. Preview deployments were therefore invoked on production cron
  schedules and executed scheduled work with production credentials (observed:
  stale previews refreshing Frame.io/Adobe tokens, reading production Supabase,
  and consuming the Dropbox rate limit). Two controls, neither relying on app
  naming: (a) **credential scoping** — the Inngest keys belong to the Production
  environment only, and preview syncing stays disabled in the Inngest–Vercel
  integration (the real boundary); (b) **fail-closed registration** —
  `selectRegisteredFunctions` (`src/lib/inngest/registration.ts`) serves an empty
  function list when `VERCEL_ENV === 'preview'` unless that specific deployment
  sets `KIT_INNGEST_ALLOW_PREVIEW=true`. The boundary keys off `VERCEL_ENV`, not
  `NODE_ENV` (preview builds also run `NODE_ENV=production`). Never set the
  preview opt-in in shared/production project settings. *(Guard Verified by unit
  tests; credential scoping is a Vercel-dashboard fact — Needs verification.)*
- **Build source / deployed branch:** *Needs verification.*
- **Health mechanism:** `healthWatchdog` (Inngest) + the `/status` page. The
  `/status` API is `src/app/api/status/route.ts`. *(Verified files exist.)*

## Supabase — database

- **Responsibility:** Postgres, the shared source of truth for all runtimes.
- **Entry point:** `supabase/migrations/` (schema). *(Verified.)*
- **Change model:** schema changes ship as new files under
  `supabase/migrations/`. *(Files Verified; the apply/deploy mechanism is
  Needs verification.)*
- **Ownership question:** *Decision required* — migration prefixes collide
  (see `.ai/audits/architecture.md`); ordering/authority needs a convention.

## External services

Auth and clients live in `src/lib/`. All are shared-library integrations used
by the runtimes above. The auth mechanisms below are confirmed from the root
`.env.example` key names and/or `src/lib/` paths. **Whether each integration is
live in production is Needs verification** — not confirmable from repo or config
in this session.

- **Slack** — Socket Mode (outbound WebSocket, per `railway.toml`), token via
  env (`SLACK_BOT_TOKEN` in `.env.example`). *(Verified from config.)*
- **Harvest** — client under `src/lib/`. Auth model *Needs verification* — no
  Harvest key is present in the inspected `.env.example`.
- **Dropbox** — OAuth refresh-token flow, `src/lib/dropbox/client.ts`.
  *(Verified: `DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN`
  in `.env.example`.)*
- **Frame.io** — Adobe IMS OAuth, `src/lib/frameio/auth.ts`.
  *(Verified: `FRAMEIO_ADOBE_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN`
  in `.env.example`.)*
- **Google Drive / Calendar** — service-account based
  (`GOOGLE_SERVICE_ACCOUNT_JSON`), feature-flagged via env
  (`DRIVE_TRANSCRIPTS_ENABLED`, `GOOGLE_CALENDAR_INGEST_ENABLED`).
  *(Verified from config; runtime enablement Needs verification.)*

## Studio / local workers

- **`kit-render-worker/`** and **`kit-deadline-relay/`** — local/studio worker
  apps. *(Verified: the directories exist.)*
- **Behavior, trigger model, and whether they are part of the running
  topology** were not inspected this sprint. *(Needs verification — read
  `AE-RENDER-FARM-HANDOFF.md` and the worker `src/` before relying on
  specifics.)*

## Unresolved ownership questions

- Which branch each platform deploys from. *(Needs verification.)*
- Dropbox `/production` is observed by more than one mechanism across runtimes
  — canonical owner undecided. *(Decision required — see
  `.ai/audits/architecture.md`.)*
