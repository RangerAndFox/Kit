# Workflow: Feature

Build the smallest thing that satisfies the requirement, reusing existing
architecture. New abstractions are the exception, not the default.

## Minimum initial context

- The requirement, stated as an observable outcome.
- `.ai/repo-map.md` to pick the owning subsystem and runtime.
- `.ai/runtime.md` to confirm where the new work will run.
- `.ai/invariants.md`.

## 1. Investigate — find the analogous path (required)

Before designing anything, find **at least one existing implementation of the
same shape** and read it:

- A similar Slack command/handler → mirror `bolt/src/handlers/`.
- A similar scheduled/background job → mirror a function in
  `src/lib/inngest/` and its registration in `src/app/api/inngest/route.ts`.
- A similar external integration → mirror a `src/lib/*/client.ts`.
- A similar job/queue flow → mirror the delivery/render patterns.

Decide the runtime owner explicitly. If the feature is a new recurring
responsibility, it needs exactly one owner (invariant 6).

## 2. Plan approval

State: the outcome, the chosen subsystem + runtime owner, the analogous path
you are copying, which invariants apply (especially idempotency, cursor
ownership, retry-safety for anything event/cron-driven), and any schema
changes (migrations). Justify any new abstraction against the analogous path —
if the analogue fits, extend it instead. Get approval before building.

## 3. Implement

- Put shared domain logic in `src/lib/`; keep handlers/crons thin.
- Register new Inngest functions in `src/app/api/inngest/route.ts` or they will
  not run on Vercel.
- Make new events/jobs/notifications idempotent from the first commit.
- Schema changes go in a new migration (mind the numbering collisions noted in
  `.ai/repo-map.md`).

## 4. Validate

Per `.ai/validation.md`, narrow → broad: add/adjust the directly affected test,
run the subsystem suite, type-check the affected package(s), then build if the
change is Vercel-bound.

## Exit / handoff

- Summarize the outcome, the runtime owner, and validation run.
- Update Atlas **only** if you added a subsystem, boundary, owner, or invariant
  (e.g. a new runtime responsibility → add to `.ai/repo-map.md` and
  `.ai/runtime.md`).

## Prohibited shortcuts

- Introducing a new abstraction without inspecting an analogous path first.
- Duplicating shared logic into a handler/cron instead of `src/lib/`.
- A schema change without a migration.

## Stop and request a decision when

- The feature adds a second observer/owner to an existing responsibility.
- It is unclear whether it belongs on Railway, Vercel, or a worker.
