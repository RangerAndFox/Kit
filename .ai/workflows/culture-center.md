# Culture Center

## Feature

Founder/admin dashboard at `/culture-center`. One bold section and editable
table per birthday, timesheet, holiday, delivery celebration and custom meme.
Supports destination, compatible template/rotation, employee/display name,
month-day birthday (no birth year), local time/time zone, recurrence, briefing,
draft/enabled/paused state, upcoming occurrences and latest 100 posting attempts.
The shared shell, Control Center and Culture Center use compact Inter typography,
neutral near-black surfaces and restrained lime primary actions. Kit branding and
all seven navigation destinations remain available on desktop and mobile.
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
  Enabled destinations must be active internal channels Kit has joined; reject external
  and organization-shared channels. Existing rules can be paused or saved as
  drafts during a Slack outage; those operations remain authorized, validated,
  workspace-scoped and audited. No token or contact details reach the UI.
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
   ambiguity or invalid seed blocks the atomic import instead of guessing.
   Preflight checks all seeds and reports row/kind/field issues without echoing
   private copy. No legacy birthday or schedule is silently dropped at handover.
6. Setup imports existing birthdays and three built-in rules. Pending custom
   celebrations import as drafts. The handover is the **start of the next local
   date** (the first valid minute if DST skips midnight); legacy jobs continue
   until then. Check the worker heartbeat before the cutoff.
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

September 14 release-candidate verification: 848 root tests and 822 Bolt tests
passed. Typecheck, lint ratchet, migration integrity and production build passed.
The redesigned shared navigation, Control Center and Culture Center were visually
checked with synthetic data. Draft save/reopen, pause during Slack channel outage
and contained mobile tables were exercised. No live Slack posts were performed.
Local checks use Node 20.20.2; supported Node 22 CI remains a release gate.

A disposable hosted Supabase branch passed `scripts/culture-hosted-test.sql`:
service-role saves, confirmation and handover gates, duplicate claims, owner/
revision fencing, uncertain-send review, pause cancellation, audit durability,
cross-workspace rejection, RLS and denied public RPC grants. Synthetic SQL writes
rolled back. Separate PostgREST service-role calls returned HTTP 200 with a single
object for save (revisions 1 then 2), and an all-null object for a non-claim.
Anonymous HTTP reads of all four tables and a posting RPC returned 401.
Generated Culture table/RPC types were merged without replacing unrelated
production types. The disposable branch and its API fixtures were deleted.

Hosted-branch limitation: automatic history replay failed because the remote
production-baseline migration is a marker with no SQL statements. The disposable
branch was bootstrapped from the local baseline after normalizing its generated
literal newline delimiters, then the unchanged Culture migration was applied.
This validates Culture against that schema, not a clean replay of every later
production migration. The immutable baseline and production history were not
modified. Do not treat this as a successful full-history migration test.

Required independent review, production migration/deploy, managed handover and
an approved test-channel post remain separate release steps. Do not report the
feature as live based on these isolated checks.

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
