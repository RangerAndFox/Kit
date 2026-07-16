# Kit — Claude Code Bootstrap

Kit is Ranger & Fox's AI production-management agent. It lives in Slack and
orchestrates project provisioning, time tracking, file management, video
review, and render/delivery pipelines across Slack, Harvest, Dropbox,
Frame.io, Supabase, Google Drive, and Google Calendar.

It spans two deployed runtimes plus optional studio machines:

- **Railway** — a persistent Slack Bolt service (Socket Mode + node-cron).
- **Vercel** — a Next.js app and the registered Inngest cron functions.
- **Supabase** — Postgres, the shared source of truth.
- **Studio workers** — optional local render/relay apps (`kit-render-worker/`,
  `kit-deadline-relay/`).

## Start here

Read this file first. **Do not broadly explore the repository**, and do not
read every `.ai/` document — select only the smallest reference the task needs.

| Your task | Read first |
|-----------|-----------|
| Understand what a subsystem is / where code lives | `.ai/repo-map.md` |
| Understand where code runs and what owns it | `.ai/runtime.md` |
| Know which rules must stay true | `.ai/invariants.md` |
| Run checks / know what proves what | `.ai/validation.md` |
| Fix a bug | `.ai/workflows/debugging.md` |
| Build a feature | `.ai/workflows/feature.md` |
| Refactor without behavior change | `.ai/workflows/refactor.md` |
| Deploy or reason about a deploy | `.ai/workflows/deployment.md` |
| Document a subsystem / write an audit | `.ai/templates/` |
| Understand Kit's Atlas layer | `.ai/README.md` |

## Operating rules

1. **Minimize context.** Identify the subsystem and exact entry point before
   reading implementation files. Use the reading-order lists in
   `.ai/repo-map.md`, not whole directories.
2. **Investigate before implementing.** Before editing, state: the
   reproduction/trigger path, the violated invariant, the root-cause mechanism,
   one analogous existing implementation, and the plan. Get plan approval for
   anything non-trivial.
3. **Prefer existing architecture.** Find one analogous path before
   introducing a new abstraction. Shared domain behavior belongs in the shared
   `src/lib/` modules, not duplicated per handler or cron.
4. **Fix mechanisms, not symptoms.** Do not raise timeouts, suppress logs, or
   duplicate logic unless the evidence shows that is the correct design.
5. **Preserve runtime ownership.** Railway owns persistent processes; Vercel
   owns the Next.js app and registered Inngest functions. Verify ownership in
   `.ai/runtime.md` before moving work across that boundary.
6. **Preserve idempotency.** External events, scheduled jobs, Slack messages,
   provisioning, notifications, and migrations must tolerate retries safely, and
   recurring work must scale with *new* activity, not total history.
7. **Keep scope narrow.** No drive-by cleanup, unrelated dependency upgrades,
   or file moves. Database changes require a migration. Secrets never enter
   source, logs, or the `.ai/` documentation.

## Validate narrow to broad

Run the cheapest check that can disprove your change first, then widen. See
`.ai/validation.md` for the ladder: directly affected test → subsystem tests →
affected package type check → package-wide checks → build → production
verification. There is no verified repo-wide test command — do not invent one.

## Stop and ask when

- Runtime ownership (Railway vs Vercel) is ambiguous for the work.
- A responsibility appears to have more than one owner (e.g. Dropbox
  `/production` observation — see `.ai/audits/architecture.md`).
- A fix would require a large refactor or change externally observable behavior.

## Keep Kit's Atlas layer current

Update `.ai/` **only** when architecture, runtime ownership, invariants, or
validation actually change — not for routine feature work. Do not turn the
`.ai/` layer back into a build diary. See `.ai/README.md` for maintenance rules.
