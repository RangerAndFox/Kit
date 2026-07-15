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
  `driveTranscriptScan`, `healthWatchdog`.
- **Trigger model:** Inngest invokes functions on their schedules/events. A
  function must be listed in `route.ts` *and* synced to Inngest to run.
  *(`route.ts` list is Verified; the Inngest sync state is Needs verification.)*
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
