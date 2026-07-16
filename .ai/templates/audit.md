# Audit template

Copy this for a focused audit. An audit is evidence-first: every finding names
the invariant at risk, the mechanism that puts it at risk, and the smallest step
that would confirm it. No speculative severity scoring — confidence is a label,
not a number.

---

# Audit: <scope title>

**Scope** — Exactly what is and is not covered. Keep it narrow enough to finish.

**Evidence** — The files, configs, and (labelled) reports examined. List what
was read; note what was deliberately not read and why.

## Findings

Order by severity (highest first). One block per finding.

### <finding title> — Severity: <blocker | high | medium | low>

- **Invariant** — Which rule in `.ai/invariants.md` is (or may be) violated.
- **Mechanism** — The concrete code/config path that creates the risk.
- **Symptom** — What goes wrong observably if the mechanism fails (or has).
- **Confidence** — `Verified` / `Production-verified` / `Needs verification` /
  `Decision required`.
- **Smallest confirmation step** — The single cheapest check that would prove
  or disprove this finding (a file to read, a query to run, a log to inspect).
- **Recommendation** — The mechanism-level fix (not a symptom patch).

## Implementation sequence

Ordered, minimal steps to act on the confirmed findings — cheapest / highest-
confidence first. Each step should be independently shippable where possible.

## Validation

How each step is validated per `.ai/validation.md` (narrow → broad), and what
can only be confirmed in production.

## Rollback

How to reverse each change if it regresses, and what signal would trigger a
rollback.

## Unresolved questions

`Needs verification` and `Decision required` items that block or scope the
audit, and who must resolve them.
