# Workflow: Refactor

A refactor changes structure, never externally observable behavior. If you
cannot state a measurable payoff and cannot show behavior is unchanged, do not
do it.

## Minimum initial context

- The specific pain being addressed (duplication, unclear ownership, a
  hot-path cost) and where it lives.
- `.ai/repo-map.md` for the subsystem, and `.ai/invariants.md`.

## 1. Investigate

- State the **measurable payoff**: e.g. "collapses two Dropbox observers into
  one owner," "removes N duplicated call sites," "bounds a scan to new rows."
  "Cleaner" alone is not a payoff.
- Establish the **behavior baseline** you must preserve: current outputs,
  side effects, event/idempotency semantics, and any tests that pin them.
- Confirm which invariants the current code upholds so the refactor keeps
  upholding them.

## 2. Plan approval

State: the payoff (with a rough measure), the exact scope (files/modules), the
behavior that must stay identical, and how you will demonstrate it stayed
identical. Get approval. If there are no tests pinning the behavior, adding
characterization tests first is part of the plan.

## 3. Implement

- Change structure only. No new features, no bug fixes riding along (do those
  separately).
- Keep public signatures/outputs stable, or update every call site in the same
  change.
- Preserve idempotency, cursor ownership, and runtime ownership exactly.

## 4. Validate

Per `.ai/validation.md`: the pinning tests must pass **unchanged**, then the
subsystem suite, then type-check the affected package(s). Behavior parity is
the pass condition — new/changed test expectations mean it was not a refactor.

## Exit / handoff

- Show the payoff was achieved and behavior is unchanged (tests + reasoning).
- Update Atlas only if the refactor changed an owner, boundary, or invariant
  (e.g. consolidating to one canonical owner → update `.ai/audits/` and the
  relevant map/runtime docs).

## Prohibited shortcuts

- Mixing behavior changes into a "refactor."
- Removing tests or loosening assertions to make a refactor pass.
- Broad reformatting/renames beyond the stated scope.

## Stop and request a decision when

- The refactor would consolidate a `Decision required` ownership question
  (e.g. Dropbox `/production`) — that decision is the human's to make first.
- The measurable payoff cannot be articulated.
