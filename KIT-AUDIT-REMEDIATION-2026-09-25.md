# Independent audit remediation — 25 September 2026

Owner: Codex implementation. User authorized the complete independent-audit remediation and production rollout. Findings are verified against current main, not assumed from the report. No claim of perfect operation is made.

## Release policy

Kit retains pull requests, eleven required automated checks, up-to-date branches, no force-push, and no branch deletion. The owner-approved Kit-only exception removes mandatory human/independent-review approval; other repositories are unchanged. Never remove the automated checks to ship a fix.

## Phase 1 — live via PR #196 / 6fab091

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
- Phase 1 deployed to Railway and Vercel at 16:20 UTC, both verified SHA 6fab091. Railway SUCCESS, Vercel READY; live bot health confirms Socket Mode connected with zero consecutive failures.
- Phase 1 migration applied at 16:09 UTC (production version 20260925160953); member constraint validated, zero mismatches, anon function execution denied. Local filename aligned to the actual production ledger. App rollout still pending final PR checks.
- Live retrieval verification caught pgvector operator resolution: production hosts the extension in `extensions`, not `public`. Follow-up migration 20260925161111 fixes the pinned search path. Test fixture now uses the real extension schema. Live NULL-workspace rejection and empty-scope query both verified after repair; no records changed.

## Phase 2 — billing integrity and newly discovered summary privacy

- PRD-6: stable staff-scoped ad-hoc intents, durable database ownership, pre-POST paginated Harvest reconciliation, and explicit already-logged receipts. Ambiguous writes retain a hold: no automatic resend. Scheduled markers remain compatible with pre-deploy cards. Content-only reconciliation requires a unique staff/Harvest mapping; shared freelancer buckets use exact per-artist intent markers only. Identical additional sessions need distinguishing notes.
- Additional security finding: both summary generators exposed budgets/SOW/private prose as team-visible knowledge. Production contained 271 originals, 70 with financial indicators. Migration 20260925161544 restricts all originals to founder and enforces the restriction for old writers. Verified 271 protected / zero unrestricted originals; no content deleted. Authorized admin/producer status-budget tools remain available. New team-safe derivatives use only structured operational fields, never freeform source text or financial metadata.
- PERF-8: nightly metadata queries scoped to the bounded current workspace/project batch, explicitly paginated and fail closed at 10,000 rows instead of silently truncating. Missing safe derivative forces regeneration.
- PERF-4/5/10: corrected typecheck claims, stale migration/watcher findings, runner coverage, and dependency prerequisites. Historical architecture audit preserved with a dated resolution addendum.
- Billing migration 20260925162518 applied and verified empty, RLS enabled, anon execution denied. No real hours written during tests.
- Validation: 1,000 Bolt tests; 921 app tests; root/Bolt/tools typechecks pass. Actual SQL fixtures cover claim ownership, conflicting receipts, rejection recovery, role denial, historical restriction and old-writer containment.
- Remaining full-audit items above are still open unless explicitly marked implemented; a successful batch is not a claim that the full audit is finished.

## Phase 3 — delivery durability and bounded discovery

- REL-1/2/PERF-7: common delivery receipt ledger, atomic unique ownership, authenticated-bot metadata reconciliation, and checked render-job acknowledgment writes. Ambiguous posts never auto-repost; an unconfirmed receipt older than five minutes is visible in health. Terminal acknowledged render jobs are filtered in SQL before the limit; active candidates rotate oldest-first.
- Caption notices now acknowledge the input only after the Slack receipt. Transient provider failures remain retryable; invalid input gets one acknowledged failure notice. Output generation remains overwrite-idempotent.
- PERF-2: persisted, leased Delivery-Queue delta cursor, two discovery pages per tick, twenty pending stability checks with four-way provider concurrency. Discovery commits before the cursor checkpoint; initial backlog preserved. Size stability requires two polls. Missing files are retained as missing, never falsely marked notified. The other Dropbox observers/cursors are unchanged.
- PERF-9: delivery notifications and updates share a bounded Slack transport; domain authorization and retry ownership remain with callers. Additional briefing bug: a five-page history cap no longer reports false absence and authorizes a duplicate send.
- Actual SQL fixtures verify claim uniqueness, expired-worker fencing, receipt consistency, and anon denial. Production migrations 20260925163858/859 applied; both new ledgers verified pristine. No notifications or uploads were sent by verification.
- Validation before final additions: 926 app tests, 1001 Bolt tests, all typechecks, lint ratchet 1233 errors/86 warnings (debt reduced, not zero). Focused render acknowledgment tests add two passing cases.
- PERF-1 live model comparison is permission-blocked: the checker requires explicit approval to send Kit's existing internal prompt/tool schemas to its Anthropic account. No requests ran; model remains unchanged. User approval requested in this task.
- DB advisor findings inspected: 26 unindexed FKs, tables generally tiny (largest estimated 130 rows); statistics reset 2026-03-30. No unused index was dropped solely from a zero counter.

## Phase 4 — runtime verification and monitoring hardening

- Cron registration now uses one bounded batch RPC instead of a parallel request per cron. Existing successes/enrollment remain unchanged; actual SQL tests verify this. Failure logs contain only stage, sanitized category and elapsed time. The intermittent configuration failure was observed again at 16:40; batching removes request amplification, but sustained production verification is still required before calling its cause resolved.
- Control Center no longer displays the persistent monitor epoch as a failing unknown cron.
- Removed automatic legacy migration from Railway startup. Redacted live configuration confirms old cutover variable names remain configured; values cannot be independently read through the connector. A stale flag can no longer trigger old-workbook adoption on a restart.
- SEC-5: studio-wide worker credential is now explicitly single-studio-only, fail-closed on database error or a second workspace. Dedicated secret remains required. Fixed a same-character-length/multibyte-token exception in timing-safe comparison. Live database has one workspace; render, Behance, ElevenLabs and Frame.io workers all have fresh heartbeats (16:46 UTC).
- REL-4: three live existing shares were inspected using the published GET shares/assets contract. All three enabled public shares contain the exact expected folder (plus an existing file); no link, media, access setting or notification was changed. Public links intentionally remain bearer-access client review links; authenticated-only sharing would be a separate policy change. [Provider schema](https://api.frame.io/v4/openapi.json).
- Workbook inspection via the Google Sheets connector confirmed the exact R&F Production Control Center ID and tab structure. All 28 bindings to that workbook have zero sync errors. Four other historical bindings belong to obvious legacy/test-named records in a different workbook; they were not deleted without exact disposition approval. Old projects below 2625 remain archived in Kit (their historical rows remain in the workbook). No workbook cells changed.
- Bound Apps Script remains unverified: the connected browser requires Google reauthentication. Connector reads do not expose installed triggers or script properties. Never print signing secrets.
- DB-1/2 disposition: do not perform speculative index churn. 110 zero-use nonunique public indexes total only 1.16 MiB, largest 16 KiB; sampled scoped transcript/brain plans already use workspace indexes, and affected FK tables are tiny. Preserve constraints, authorization-provider indexes, and growth-ready indexes. Revisit covering indexes with measured slow-query evidence rather than adding/dropping 100+ indexes to silence INFO advisors. [Advisor guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys).
- Security advisors: zero WARN/ERROR; fourteen INFO notices are intentionally service-role-only deny-all tables, including the new receipt/cursor/billing ledgers. [RLS guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

## Remaining decisions / follow-ups (not silently completed)

1. Explicit permission for the live synthetic model comparison (PERF-1). No model change or test request made after the permission rejection.
2. Google reauthentication to inspect bound Apps Script triggers and webhook-signing setup.
3. The 24 unresolved upload attempts on 2631/2633/2636 still need exact delivered-replacement evidence or owner confirmation before retirement. Fabric/Jimmy retirement remains intact.
4. Postgres engine maintenance: deployed 17.6 versus newer provider security releases warrants a scheduled upgrade check/backup validation, not an unannounced database restart during production.
5. Optional product additions (delivery-link dashboard, richer AI-cost panel) are backlog suggestions, separate from correcting the audited defects. No fabricated cost or worker data is displayed.
