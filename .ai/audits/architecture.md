# Audit seed: Architecture

**Status:** seed only. This is not a full architecture audit — it records
confirmed initial findings and frames the methodology for a later pass. No
speculative scoring.

**Scope (this seed):** structural risks visible from the permitted bootstrap
context (manifests, configs, top-level layout, migration filenames). It does
**not** cover subsystem-internal logic.

**Evidence examined:** `package.json`, `bolt/package.json`, `tsconfig.json`,
`bolt/tsconfig.json`, `railway.toml`, `bolt/Dockerfile`,
`src/app/api/inngest/route.ts`, top-level directory listing,
`supabase/migrations/` filenames, and the presence of the two Dropbox watcher
files. Subsystem internals were not read.

## Confirmed initial findings

### 1. Dropbox `/production` has more than one observation mechanism — Decision required

- **Invariant at risk:** #6 (one canonical owner per responsibility) and #10
  (explicit cursor ownership).
- **Mechanism (Verified — files exist):** at least two distinct code paths
  observe Dropbox `/production` activity:
  - `bolt/src/watchers/dropbox.ts` — a Dropbox watcher on the Railway Bolt
    service.
  - `src/lib/delivery/dropbox-watcher.ts`, driven by the Inngest cron
    `deliveryDropboxScan` (registered in `src/app/api/inngest/route.ts`, runs
    on Vercel).
  What each path observes, and whether they overlap, was not inspected this
  sprint.
- **Symptom (potential):** the same file event handled twice, duplicated jobs
  or notifications, or ambiguous cursor advancement.
- **Confidence:** the *existence* of multiple observation paths is **Verified**
  (both files are present). Whether they overlap on the same paths/events, and
  which should be canonical, is **Decision required** — it needs targeted
  analysis of the current implementation of each.
- **Smallest confirmation step:** read `bolt/src/watchers/dropbox.ts` and
  `src/lib/delivery/dropbox-watcher.ts` and compare the Dropbox paths, event
  sources, and dedupe/cursor keys each uses.

### 2. Supabase migration numbering collides — medium

- **Invariant at risk:** #1 (migrations are the schema source) — ordering must
  be unambiguous.
- **Mechanism (Verified):** prefixes `032`, `033`, `034`, `035` each appear on
  two different migration files (e.g. `032_ae_render_farm.sql` and
  `032_hours_missing_alerts.sql`).
- **Symptom (potential):** ambiguous apply order, or a tool that orders by
  prefix applying them inconsistently across environments.
- **Confidence:** **Verified** (filenames). Impact depends on how migrations
  are applied (Supabase MCP `apply_migration`, per `CLAUDE.md`) — **Needs
  verification**.
- **Smallest confirmation step:** confirm the apply mechanism's ordering rule
  and whether both files in each colliding pair are already applied.

### 3. Two package roots, divergent TS config — low (documentation risk)

- **Mechanism (Verified):** root (`kit-app`, ES2017, `strict: true`,
  `noEmit`) and `bolt/` (`kit-bolt`, ES2022, `strict: false`) build
  independently with separate dependency trees; `src/lib/` is shared by both.
- **Symptom (potential):** code that type-checks under `bolt/`'s relaxed
  config but fails the root's strict config, or vice versa; drift between the
  two `@anthropic-ai/sdk` versions.
- **Confidence:** **Verified**. Whether real breakage exists is **Needs
  verification**.

## Open questions

- Canonical owner of Dropbox `/production` observation. *(Decision required.)*
- Migration ordering authority and the collision-resolution convention.
  *(Decision required.)*
- Deployed branch/source for Railway and Vercel. *(Needs verification —
  see `.ai/runtime.md`.)*
- Are the studio workers (`kit-render-worker/`, `kit-deadline-relay/`) part of
  the always-on topology or on-demand? *(Needs verification.)*

## Future audit methodology

1. For each `Decision required` item, do the smallest confirmation step above
   before any structural change.
2. Document each affected area with `templates/subsystem.md` first, so the
   audit reasons over one canonical description per subsystem.
3. Use `templates/audit.md` for the full pass; keep findings mechanism-first
   and confidence-labelled. Do not assign numeric risk scores.
