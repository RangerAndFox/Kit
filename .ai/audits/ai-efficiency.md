# Audit seed: AI efficiency

**Status:** seed only. Records confirmed cost drivers for Claude Code sessions
on Kit and how to measure them later. No speculative scoring.

**Scope (this seed):** the cost of an agent becoming productive on this repo —
context cost (how much must be read) and discovery cost (how much must be
searched because it is not written down). Framed from the permitted bootstrap
context.

**Evidence examined:** the previous `CLAUDE.md` (historical version), the
manifests and configs listed in `.ai/audits/architecture.md`, and the absence
of certain validation scripts.

## Confirmed findings

### 1. The previous `CLAUDE.md` was a historical implementation diary — recurring context cost

- **Problem:** the prior `CLAUDE.md` embedded a full multi-session build log
  ("Session History — What Was Built", phases 1–7, per-feature narratives),
  complete environment-variable inventories, and OAuth walkthroughs.
- **Cost:** every session paid to read a large, mostly historical document to
  extract a small amount of durable, actionable guidance — and diary content
  goes stale, actively misleading future sessions.
- **Symptom (Verified in the old file):** the diary asserted
  `bolt/.env.example` as an env manifest, but **that file does not exist** —
  only the root `.env.example` does. A session trusting the diary would look
  for a non-existent file.
- **Confidence:** **Verified.**
- **Fix (this sprint):** `CLAUDE.md` is now a concise bootstrap + router;
  durable knowledge moved into labelled Atlas docs; history stays in the
  existing `*-SPEC.md` / `SESSION-HANDOFF.md` files, out of the read-every-time
  path.

### 2. Missing canonical validation commands — discovery cost

- **Problem:** there is no single, discoverable way to validate the repo.
  - Root `package.json` (`kit-app`) has **no `test` script** and no test
    runner dependency. *(Verified.)*
  - `src/lib/health/*.test.ts` files exist but no root vitest config/dep
    references them, and `bolt/tsconfig.json` does not include
    `src/lib/health`. Which runner executes them is unclear. *(Verified the
    files exist; the runner is Needs verification.)*
  - Type-checking and linting are split across two package roots with no
    umbrella command; `bolt/` has no lint script.
- **Cost:** each session must rediscover what to run and what it proves,
  repeatedly.
- **Confidence:** the gaps are **Verified**; the *impact* per task is **Needs
  verification**.
- **Mitigation (this sprint, docs-only):** `.ai/validation.md` inventories the
  commands that do exist and names the gaps explicitly, so sessions stop
  hunting. Adding canonical scripts is deferred (would change executable
  behavior — out of scope).

### 3. Durable knowledge was scattered across many root docs — discovery cost

- **Problem:** operational truth was spread across `README.md`, `FEATURES.md`,
  `OPERATOR-TODO.md`, `SESSION-HANDOFF.md`, and several `*-SPEC.md` /
  `*-HANDOFF.md` files, with no authority hierarchy.
- **Cost:** an agent cannot tell which document to trust or read first.
- **Confidence:** **Verified** (these files exist at the repo root).
- **Mitigation:** Atlas establishes the authority hierarchy
  (`.ai/README.md`) and a single routing entry point (`CLAUDE.md`).

## Future audit methodology

1. Measure context cost per common task: count files/lines a session must read
   to make a typical change in each subsystem; target reductions via
   `templates/subsystem.md` reading-order lists.
2. Measure discovery cost: track how often sessions search for a validation
   command or an owner that should be written down.
3. Re-evaluate the validation gaps once (if) canonical scripts are added in a
   code-touching sprint; then update `.ai/validation.md`.
