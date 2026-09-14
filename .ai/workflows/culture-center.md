# Culture Center

## Feature

Founder/admin dashboard at `/culture-center`. One bold section and editable
table per birthday, timesheet, holiday, delivery celebration and custom meme.
Supports destination, compatible template/rotation, employee/display name,
month-day birthday (no birth year), local time/time zone, recurrence, briefing,
draft/enabled/paused state, upcoming occurrences and latest 100 posting attempts.
New dashboard rules are draft-first. Enabled edits require explicit review.
This is not a new project-data store and does not change Sheets or project canvases.

## Ownership and safeguards

- **Vercel:** page and `/api/culture-center` GET/POST. Authoritative
  `getControlCenterAccess` re-verifies founder/admin for each request. Workspace
  and actor derive from that access record, never from submitted JSON.
- **Railway:** `bolt/src/culture/runner.ts`, ticked once/minute by `app.ts`.
  The web app does not schedule or send memes. Existing Slack commands and
  delivery events delegate to the managed rules after handover.
- **Supabase:** service-only `culture_workspaces`, `culture_memes`,
  `culture_posts`, `culture_audit`. RLS plus revoked anon/authenticated grants;
  service-only, invoker-rights RPCs. Atomic revision checks, updates and audits.
- **Slack:** verified bot team must map to exactly one persisted workspace.
  Destinations must be active internal channels Kit has joined; reject external
  and organization-shared channels. No token or contact details reach the UI.
- Custom/ad-hoc captions stay text-only in Slack, not the public image renderer.
  Built-in image prompts remain generic. Conservative financial/contact/link
  guards apply to input and generated captions. These guards are not a proof of
  privacy; the admin review of public-safe copy is still required.
- Birthday imports expose only Slack ID, display name, month/day. Other contact
  information, rates, budgets, margins and transcripts are not loaded.

## Scheduling semantics

Scheduled rules have a five-minute local-time window, with no late catch-up.
An occurrence is unique by rule + local date. DST repeated times share one key;
nonexistent times are skipped. Delivery keys add a hash of the project name,
keeping existing once-per-project/day behavior. Renaming a project can change
that event identity; this is not a per-file celebration system.

The worker claims before preparation, checks the current revision immediately
before sending, then stores Slack's timestamp. Managed Slack transport performs
one HTTP attempt, without SDK retries. Preparation errors may retry inside the
window; ambiguous sends become `review` and are never automatically resent.
An expired `sending` lease is likewise marked for review. In-flight sends block
configuration edits; editing cancels claimed/failed attempts. Pausing cannot
recall an already-sent message. History is bounded to the most recent 100 rows
in the UI; the database retains the durable records.

The worker budgets 40 seconds per tick before starting another item; one already
started item can run longer, bounded by provider timeouts. An in-process guard
prevents overlapping ticks; DB claims protect across workers. A very large
simultaneous batch can miss its five-minute window. Do not schedule hundreds of
rules at one minute without extending this into a dedicated work queue.

## Setup and deployment sequence

1. Obtain the required independent code review and passing Node 22 CI gates.
   Do not bypass protected-branch review. Publishing this branch to the public
   GitHub repository is a separate release step requiring destination approval.
2. Validate migration `20260914131527_culture_center.sql` in a clean Supabase
   branch/local stack with existing schema, validate service-role RPC shape and
   regenerate database types. PGlite smoke tests are useful but are not a full
   hosted Supabase/PostgREST test. Do not use production DDL for experimentation.
3. Apply the approved migration using the normal Supabase migration mechanism.
   Deploy Railway and Vercel from the reviewed commit. Confirm the old Railway
   instance has stopped. Keep one production scheduler; never run a local Bolt
   process with production Slack credentials.
4. Verify the production bot's `auth.test` team matches `workspaces.slack_team_id`.
   Verify server-only Supabase service credentials and Slack bot token on both
   runtimes, plus the existing caption/image provider credentials on Railway.
   The bot requires channel listing/info access for internal joined channels.
5. Open Culture Center as founder/admin. Before setup, the page is read-only
   and the legacy schedule remains active. Choose the initial destination and
   studio time zone and click **Import existing memes** after reviewing it.
   Legacy global tables import only when exactly one workspace exists. Any
   ambiguity/invalid birthday blocks the import transaction instead of guessing.
6. Setup imports existing birthdays and three built-in rules. Pending custom
   celebrations import as drafts. The handover is the **next local midnight**;
   legacy jobs continue until then. Check the worker heartbeat before the cutoff.
   Review imported destination/template/date values and pending custom drafts.
7. After cutoff, verify role denial for artists/producers, perform a reversible
   draft edit, then an approved test-channel scheduled post. Confirm one Slack
   message, one posted ledger row and no legacy duplicate on a second tick.
   Verify birthday changes from an existing authorized Slack command appear in
   the same dashboard record. Never use a real birthday to trigger a test send.

Do not delete `culture_workspaces` or roll back to an unaware old bot to disable
managed mode: that re-enables legacy schedules and can double-post. Pause rules
through the editor instead. For an outage, retain the ledger and configuration,
stop the affected scheduler if necessary, then roll forward. Review uncertain
posts in Slack before any deliberate remediation; no automatic replay button.

## Local verification

September 14 implementation check: 845 root tests and 815 Bolt tests passed;
typecheck, lint ratchet, migration integrity and production build passed. The
PostgreSQL/PGlite migration harness passed. Synthetic browser checks covered
draft save/reopen, date edit/save, required enable review, Escape dismissal,
seven populated/empty tables, and contained table scrolling at 390px width.
No Slack posts or production mutations were performed. These local checks used
Node 20.20.2; supported Node 22 CI and hosted Supabase validation remain release
gates. No independent review, public push or deployment is claimed here.

- `npm run typecheck`
- `npm run test:app`
- `npm test --prefix bolt`
- `npm run lint:ratchet` (legacy lint debt exists; no new debt allowed)
- `npm run check:migrations`
- `npm run build`
- Install `@electric-sql/pglite` in an isolated temporary directory and run
  `CULTURE_PGLITE_PATH=/absolute/path/to/pglite/dist/index.js node scripts/test-culture-database.mjs`.
  This executes the actual migration and checks grants/RLS, initialization,
  audits, cross-workspace denial, optimistic edits, cutover, claims and fencing.

Browser verification must use synthetic people and a local in-memory API fixture
unless an authenticated test environment is explicitly available. Never add a
public auth-bypass route. Verify draft save/reopen, required enable review,
keyboard dismissal, empty tables, and horizontal scrolling contained inside
tables on mobile. Live Slack delivery is a separate release verification.
