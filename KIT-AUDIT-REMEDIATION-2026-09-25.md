# Independent audit remediation — 25 September 2026

Owner: Codex implementation. User authorized the complete independent-audit remediation and production rollout. Findings are verified against current main, not assumed from the report. No claim of perfect operation is made.

## Release policy

Kit retains pull requests, eleven required automated checks, up-to-date branches, no force-push, and no branch deletion. The owner-approved Kit-only exception removes mandatory human/independent-review approval; other repositories are unchanged. Never remove the automated checks to ship a fix.

## In progress on `codex/full-audit-remediation`

| Audit item | Work / remaining verification |
| --- | --- |
| SEC-1 | Signed MCP acting Slack identity; agent tools reject missing identity and ignore supplied actor; nested dispatch identity overwritten. Regression tests pass. |
| SEC-2 | Mandatory workspace in knowledge retrieval, including direct brain selection; migration rejects NULL workspace. Pending database verification. |
| SEC-3 | Provider-only HTTPS redirect validation at every hop; bounded image download; private/IP/lookalike targets refused. Pending full gates. |
| SEC-4 | MCP project/member workspace checks plus composite member FK (project FK already exists); live preflight found zero mismatches. Pending migration verification. |
| SEC-6 | Removed startup token suffix logging. |
| PRD-7 | Unknown/ambiguous Slack team fails closed rather than selecting the first workspace. |
| PRD-2/3 | Honest Frame.io signup handoff in requester summary; dead Connect welcome branch removed. Pending receipt tests. |
| PRD-5 | Entry now uses authoritative admin/producer tier, matching execution. CD-only roles fail before the form; no broad financial elevation. |
| REL-1 | Delivery and caption notifications moved into per-file durable steps. Pending replay regression. |
| Additional finding | Delivery cron heartbeats were stamped successful before work. Attempt and completion stamps separated. |

## Still to implement or disposition with evidence

- PRD-6: ad-hoc duplicate hours, concurrency-safe intent ownership, pre-POST reconciliation and duplicate UI.
- REL-2/PERF-7: first job message crash window and terminal-row starvation.
- PERF-2: persisted bounded Delivery-Queue discovery, preserving initial backlog and pending-file stability checks.
- PERF-1: model routing cost change only after current-model validation and routing evaluation.
- PRD-1: implemented. Removed unavailable primary links. Settings now shows a real workspace-scoped, read-only roster. Additional finding: all other settings controls were local-only prototypes (including fake security rules and audit events); redirected them to verified surfaces rather than presenting pretend saves.
- PERF-3: quarantined managed-agent registration with a structural 404; preserved historical source with explicit dormant status. No in-repository invocation path exists. Bolt specialists remain live.
- PRD-4: **report partially stale** — `brain why` already performs actual provenance retrieval, not a placeholder; descriptions are stale. The registry refresh action only gives guidance; do not report a refresh as completed.
- PERF-4/5/6/10: correct invariants, watcher ownership, migration and validation documentation.
- PERF-8/9/LINT: bounded nightly metadata reads, shared Slack transport, reduce touched lint debt without weakening baseline.
- DB-1/2: inspect advisor findings, plans and usage age; do not drop indexes merely because counters currently show zero reads.
- SEC-5: verify single-studio worker boundary and document multi-workspace gate.
- REL-4: verify real Frame.io folder shares and record sharing policy without changing client access silently.
- Production: diagnose transient cron-registration failures; verify old workbook environment gates, Apps Script/Sheets coverage, Railway and Vercel revision parity.
- Feature suggestions: onboarding receipts and duplicate-entry guard belong with fixes; delivery-link dashboard and cost observability need scoped implementation after reliability gates.

## Historical uploads: separate, unresolved evidence

Fabric 2637 and Jimmy Kimmel 2639 queues were already retired under explicit authorization. Do not re-upload them.

The 24 remaining records for 2631/2633/2636 have not been declared delivered by the user. Matching filenames and byte counts alone do not prove replacement provenance. Preserve these records and keep unresolved outcomes visible; do not mark successful or retire them to clear alerts.

## Verification ledger

- Initial identity/knowledge regression: 6 tests passed.
- Initial root + Bolt + tools typecheck passed after mandatory workspace caller fixes.
- Full initial suites: 996 Bolt / 910 app tests. Actual SQL migration executed in isolated PGlite with vector extension: NULL scope, cross-workspace insert, parent workspace reassignment, anon access all rejected; valid scoped retrieval and grant succeed.
- Production build succeeds. Lint ratchet improves to 1253 errors / 87 warnings (stock debt, not a clean lint result).
- Production read at 16:00 UTC: Behance/ElevenLabs succeeds, monitoring configuration recovered; only historical Dropbox inbox alert remains. No retirement or successful-upload claim was made for the 24 unresolved records.
- No changes from this branch have been deployed yet.
- Phase 1 migration applied at 16:09 UTC (production version 20260925160953); member constraint validated, zero mismatches, anon function execution denied. Local filename aligned to the actual production ledger. App rollout still pending final PR checks.
- Live retrieval verification caught pgvector operator resolution: production hosts the extension in `extensions`, not `public`. Follow-up migration 20260925161111 fixes the pinned search path. Test fixture now uses the real extension schema. Live NULL-workspace rejection and empty-scope query both verified after repair; no records changed.
