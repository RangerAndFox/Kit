# Kit Atlas Layer — AI Engineering Context

This directory (`.ai/`) is Kit's repository-local **AI engineering context and
workflow layer**. It exists so that any Claude Code session (or human) can act
correctly on this repository while reading as little as possible.

The canonical **Atlas OS** specification is maintained separately in the
[`steve-rangerandfox/atlas-os`](https://github.com/steve-rangerandfox/atlas-os)
repository. This directory is *aligned with* that specification but does **not**
implement, redefine, or supersede it — it is simply where Kit keeps its own
durable engineering knowledge. References to "Atlas" below are shorthand for
this local layer.

This layer holds **durable, evidence-backed operational knowledge**: what runs
where, what must stay true, how to validate, and how to work. Its purpose is to
reduce context cost. It is not a changelog, a feature list, or a build diary.
Those already exist elsewhere in the repo (`README.md`, `FEATURES.md`, the
`*-SPEC.md` / `*-HANDOFF.md` files).

## How to use Atlas

- **Agents:** start from the root `CLAUDE.md` routing table. Open only the
  single document your task needs. Do **not** read every file in `.ai/` by
  default — that defeats the purpose.
- **Humans:** treat these as the canonical reference for architecture, runtime
  ownership, invariants, and validation. Update them when those things change.

## Document authority hierarchy

When sources disagree, trust in this order:

1. **Code and configuration** in the repository (the ground truth).
2. **Atlas documents** labelled `Verified` or `Production-verified`.
3. **Atlas documents** labelled `Needs verification` / `Decision required`.
4. Everything else (`README.md`, `FEATURES.md`, spec/handoff docs, comments).

If Atlas contradicts the code, the code wins — and Atlas must be corrected.

## Evidence labels

Every non-obvious claim carries one label:

- **Verified** — confirmed directly in repository code or configuration.
- **Production-verified** — confirmed from supplied production evidence, not
  from the repo alone.
- **Needs verification** — plausible but not confirmable from the permitted
  context.
- **Decision required** — architecture or ownership is currently ambiguous and
  a human must decide.

Prefer "Needs verification" over asserting something you did not confirm.

## Maintenance rules

- Extract durable knowledge; never paste large sections of other docs.
- Keep each document scannable. **Target ≤ ~200 lines per document**; if one
  grows past that, split it or move detail into a subsystem doc.
- State unknowns explicitly with a label. Silence reads as fact.
- Never include secret values, tokens, or full credential inventories.
- No historical implementation diaries or per-release status notes.

## When to update Atlas

Update when — and only when — one of these **changes**:

- **Architecture** — a subsystem, boundary, or data flow is added/removed.
- **Runtime ownership** — what runs on Railway vs Vercel vs a worker.
- **Invariants** — a rule that must stay true is added, removed, or changed.
- **Validation** — how the project is checked or built changes.

## When *not* to update Atlas

- Routine feature work that touches no boundary, owner, invariant, or check.
- Bug fixes that restore an already-documented invariant.
- Anything you would put in a changelog or PR description instead.

## Layout

```
.ai/
  README.md          — this file
  repo-map.md        — subsystems, entry points, owners, reading order
  runtime.md         — where code runs and how it is triggered
  invariants.md      — rules that must stay true
  validation.md      — commands, what they prove, and the ladder
  workflows/         — debugging, feature, refactor, deployment
  templates/         — subsystem.md, audit.md
  audits/            — architecture.md, ai-efficiency.md (seeds)
```
