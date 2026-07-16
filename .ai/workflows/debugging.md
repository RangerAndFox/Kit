# Workflow: Debugging

Fix the mechanism, not the symptom. Reason **invariant → mechanism → symptom**,
then repair the mechanism so the invariant holds again.

## Minimum initial context

- The symptom: what was observed, where (which runtime), and when.
- The root `CLAUDE.md` routing table + `.ai/repo-map.md` to locate the
  subsystem and its entry point.
- `.ai/invariants.md`.

Do not open implementation files until you can name the subsystem.

## 1. Investigate (invariant → mechanism → symptom)

1. **Invariant** — which rule in `.ai/invariants.md` is being violated? If none
   fits, either the symptom is expected behavior or you have found a new
   invariant. Name it before continuing.
2. **Mechanism** — trace, from the subsystem entry point, the exact code path
   that is *supposed* to uphold that invariant. Identify where it fails.
3. **Symptom** — confirm the observed symptom is explained by that mechanism
   failure. If it is not fully explained, keep tracing; do not fix yet.

Establish a reproduction or trigger path. For event/cron code, identify the
cursor/ledger and whether a retry would repeat or skip work.

## 2. Plan approval

State, in one place: violated invariant, failing mechanism, root cause, one
analogous correct implementation elsewhere in the repo, and the proposed fix
(the smallest change that restores the invariant). Get approval before editing
anything non-trivial.

## 3. Implement

- Change only the mechanism at fault. No unrelated cleanup.
- Preserve idempotency and cursor ownership (invariants 7–11).
- If the fix needs a schema change, add a migration.

## 4. Validate

Follow the ladder in `.ai/validation.md`, narrow → broad: reproduce-then-fix
test first, then the subsystem tests, then type check the affected package.

## Exit / handoff

- State the invariant restored and how the fix upholds it.
- Note the validation actually run (and anything only verifiable in production).
- Update Atlas only if an invariant, owner, or boundary changed.

## Prohibited shortcuts

- Raising timeouts, adding retries, or widening `catch` blocks to hide the
  symptom.
- Marking an event "seen"/consumed to stop it recurring without fixing the
  processing failure (violates invariant 11).
- Suppressing logs or errors instead of handling the cause.

## Stop and request a decision when

- The invariant has more than one candidate owner (e.g. Dropbox `/production`).
- The correct fix crosses a runtime boundary (Railway ↔ Vercel ↔ worker).
- The fix would require a large refactor to do properly.
