# Invariants

Rules that must stay true for Kit to behave correctly. Violating one is a bug
even if tests pass. Debugging starts here: **invariant → mechanism → symptom**
(see `.ai/workflows/debugging.md`).

Two tiers below: invariants **verified in the current codebase**, and
**proposed target invariants** that Atlas asserts as the intended discipline
but are not yet fully confirmed across the repo.

## Verified current invariants

1. **Database changes require a migration.** Schema lives in
   `supabase/migrations/`; there is no other schema source. *(Verified.)*
2. **Secrets never enter source, logs, or Atlas.** Only `.env.example` (key
   names, no values) is committed at the repo root. *(Verified.)*
3. **Shared domain code has one home.** Integration/domain logic lives in
   `src/lib/` and is imported by both runtimes; it is not reimplemented per
   handler. *(Verified structurally via `bolt/tsconfig.json` path aliases and
   the Dockerfile copying `src/lib/`.)*
4. **A runtime is defined by an entry point.** Railway = `bolt/src/app.ts`;
   Vercel crons = the `serve()` list in `src/app/api/inngest/route.ts`. A
   function that is not registered in `route.ts` does not run on Vercel.
   *(Verified.)*
5. **The `/health` endpoint reflects real Slack connectivity.** The Railway
   health probe depends on it; it must not regress to an always-200 stub.
   *(Verified intent in `railway.toml` + `bolt/Dockerfile` comments.)*

## Proposed target invariants

These express the engineering discipline Atlas enforces. Confirm the relevant
mechanism in code before assuming full compliance.

6. **One canonical owner per runtime responsibility.** Each externally
   observable job (a scan, a notification, a webhook reaction) has exactly one
   authoritative producer. Multiple observers of the same source is a defect.
   *(Currently violated candidate: Dropbox `/production` — Decision required,
   see `.ai/audits/architecture.md`.)*
7. **Recurring work is proportional to new activity, not total history.**
   Scans, sweeps, and cron jobs must bound their work to what changed since the
   last cursor, never re-process all history each run.
8. **External events and scheduled jobs are retry-safe.** Any handler that
   receives a webhook, claims a job, or runs on a schedule must produce the
   same result if invoked twice.
9. **Provisioning and notifications are idempotent.** Re-running project
   provisioning or re-firing a notification must not create duplicates.
   Externally triggered work and notifications must have explicit *persisted*
   deduplication or idempotency (a dedupe ledger, a per-status flag, or an
   equivalent). *(Target invariant — confirm the specific mechanism in the
   relevant subsystem before relying on it.)*
10. **Cursor ownership is explicit.** Every scan/watcher owns a named cursor
    or ledger key and no other component advances it. Shared/implicit cursors
    are a defect.
11. **A failed operation must not silently consume an external event.** If
    processing a webhook or job fails, the event must be retryable or dead-
    lettered — never marked "seen" such that the work is lost — unless
    dropping it is an explicit, documented design choice.
12. **Runtime ownership is verified before work moves.** Do not relocate a job
    between Railway and Vercel (or into a worker) without confirming the target
    runtime's trigger model in `.ai/runtime.md`.
13. **Shared behavior stays shared.** New cross-cutting domain logic goes into
    a `src/lib/` module, not duplicated into a Bolt handler and an Inngest
    cron.
14. **Project Control is one-way and single-bound.** The Master Project List row
    is authoritative; the Slack Project Control Canvas is a rendered view only.
    Each project has at most one binding, one bound Canvas, and one Sheet
    developer-metadata record (`kit_project_id`); Kit never writes the workbook's
    margin/formula columns, and sync never edits a canvas other than the
    binding's persisted `canvas_id`. *(Verified — migration 056 unique
    constraints + `src/lib/project-control/`.)*
15. **Project-control provisioning is durable and Railway-recovered.**
    Provisioning is a per-service durable ledger (`project_provisioning_steps`),
    so a restart resumes only the incomplete services, never re-running a
    completed one. Nonterminal creation requests (expired lease) and incomplete
    bindings (`creation_state != 'connected'`) are recovered by the **Railway**
    recovery sweep — the Vercel/Inngest sync only re-renders already-`connected`
    bindings and must not be extended to complete creation. A user `cancel` is
    the terminal `cancelled` status and is never resumed. Leases are renewable
    (heartbeat) and fenced (a per-resource monotonic `fence` bumped on reclaim);
    a worker that loses its lease stops before writing. *(Verified — migration
    057 + `provisioning-steps.ts`/`recovery.ts`/`store.ts` + tests.)*

## How to use these

- **Fixing a bug:** name the invariant it violates first. If none fits, you may
  have found a new invariant — propose it (see maintenance rules in
  `.ai/README.md`).
- **Adding a feature:** check which invariants your change must preserve,
  especially 6–11 for anything event-driven or scheduled.
