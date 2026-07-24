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
    binding's persisted `canvas_id`. The one-way contract is enforced by three
    mechanisms, none relied on alone: (a) every render carries a prominent
    **generated-view notice** at the top directing edits to the Master Project
    List and warning that Canvas edits are overwritten; (b) sync is a
    **deterministic full-document replace** rendered only from the template
    snapshot + the authoritative Sheet row, so a manual Canvas edit is never an
    input and can never become source data; (c) the managed Canvas is created
    **read-only for the channel** (`canvases.access.set access_level='read'`),
    while Kit continues to edit via its own app token. *(Verified — migration 056
    unique constraints + `src/lib/project-control/`; the read-only grant's enum
    is verified against `@slack/web-api`, but the read + Kit-edit interaction is
    a staging-runbook item, so the notice + full re-render are the guaranteed
    safeguards.)*
15. **Project-control provisioning is durable, effectively-once, and Railway-recovered.**
    Provisioning is a per-service durable ledger (`project_provisioning_steps`)
    with per-step ownership (holder + monotonic fence + lease); the final result
    write is holder/fence-conditional, so a reclaimed stale worker cannot commit.
    A request is `completed` ONLY when every required step reached `done` (DB-
    backed); otherwise it stays recoverable (`provisioning`) or surfaces a
    permanent `terminal` step — never silently completed. External delivery is
    **effectively-once through durable ownership + reconciliation, NOT provider-
    level exactly-once**: each external provision (Harvest by notes marker,
    Frame.io by an embedded Kit-UUID label marker with explicit 0/1/multiple,
    Slack by a deterministic Kit-suffixed channel name) reconciles before
    creating, so a crash between create and the ledger write reconciles instead
    of duplicating. Recovery is step-based as well as request-based (it finds
    incomplete steps even if the request row is inconsistent). A `replace`
    persists `decision` + the conflict `replace_target_project_id` at PROMPT time
    and commits duplicate/replace/cancel via an atomic compare-and-set out of
    `awaiting_decision` (only one racing click wins); replacement cleanup is a
    durable step whose failed delete keeps the request incomplete and can never
    delete the replacement. Store reads that gate replay THROW on DB error (never
    an empty ledger). Ownership is enforced before every irreversible external
    write; release is holder-qualified; workflow external calls are timeout-
    bounded. *(Partially verified — migration 056 (durability folded in) + the
    `src/lib/project-control/*` + agent reconcilers are unit-tested; the Bolt
    wiring in `bolt/src/handlers/interactions.ts` is `@ts-nocheck` and its live
    Slack/Supabase paths are NOT exercised by tests. Do not mark fully Verified
    until the Bolt orchestration boundary has production-path coverage.)*

16. **Experimental evidence has one structured owner; rendered artifacts are
    projections; final conclusions require deterministic completeness.** A pilot's
    state lives in Supabase (migration 058: `pilots` + append-only
    `pilot_evidence` / `pilot_generations` + `pilot_references` /
    `pilot_material_maps` / `pilot_validations`); any Slack Canvas is a
    deterministic **read-only projection** rendered only from that state
    (`src/lib/pilots/render.ts`) and is never authoritative. Evidence categories
    (measurement / observation / judgment / assumption / unknown / risk /
    decision) stay semantically separated — a subjective judgment is never filed
    as an objective measurement. Append-only evidence has **no update path**, and
    a generated output may only transition its **attributed** acceptance (nothing
    accepted by default). Derived metrics (usable-output rate) come only from the
    deterministic owner (`src/lib/pilots/metrics.ts`) — never stored
    authoritatively or produced by a model, and the zero-output case is explicit
    (rate = null, not 0). A pilot reaches a final recommendation only when the
    pure completeness gate (`src/lib/pilots/completeness.ts`) passes, enforced in
    the state-transition owner; the recommendation is **human-authored**, never
    model-generated. At most one **active** pilot per (project, type). *(Verified
    in `src/lib/pilots/*` unit + controlled-workflow tests — 55 cases via
    `npx tsx --test` (incl. cross-workspace authorization rejection for every
    operation). **Operator diagnostics are read-only projections:**
    `src/lib/pilots/diagnostics.ts` (readiness / status / completeness-explain)
    derives every value from authoritative state at read time and stores no new
    authoritative summary; the deterministic completeness owner
    (`completeness.ts`) remains the single source for finalization, and a Canvas
    failure never corrupts pilot state (retry-safe). The DB constraints/triggers
    are defined in migration 058
    but NOT yet applied; do not mark the structural DB guarantees fully verified
    until the migration is applied.)*

## How to use these

- **Fixing a bug:** name the invariant it violates first. If none fits, you may
  have found a new invariant — propose it (see maintenance rules in
  `.ai/README.md`).
- **Adding a feature:** check which invariants your change must preserve,
  especially 6–11 for anything event-driven or scheduled.
