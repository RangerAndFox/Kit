# Verified heartbeat and retirement release

Implementation branch: codex/verified-heartbeats-retirement.
Scope: correct the nine blockers in Codex's review of Claude's heartbeat/retirement draft. Claude's audit remains input, not proof of implementation or deployment.

## Corrections

| Review | Implemented correction |
|---|---|
| R1 | Exact positive provider evidence required; reconciler has no write path |
| R2 | Retirement audit + transfer + inbox markers in one database transaction |
| R3 | Exact full revision, project, file ID, transfer version and event manifest |
| R4 | Refuse all processing claims, worker retirement guard, immutable retired transfers; no stale reconciler writes |
| R5 | Revoke default service-role mutation privileges; audit has no cascading FK and rejects mutation |
| R6 | Runtime-owned persisted enabled/schedule/timezone metadata; historical heartbeat never overrides explicit disablement |
| R7 | Persistent per-job enrollment; daily grace still requires preceding due run; cold starts cannot reset grace |
| R8 | Behance Slack acknowledgement occurs only after chat.update succeeds, conditional on the exact job updated_at |
| R9 | Reconciliation report corrected: sibling/older revision/404 evidence does not establish delivery |

## Telemetry contract

Railway registers its own enablement and schedule at startup, and repairs registration on attempts/successes. Vercel registers only its own jobs. The shared record_kit_cron RPC preserves enrollment across restarts, preserves prior success on attempts, and resets enrollment only on an explicit disabled-to-enabled transition. Database timestamps are monotonic.

Eleven frequent/daily Railway jobs are monitored. Timezone comes from the worker's CHECKIN_TIMEZONE. Weekday schedules are weekend/DST aware. A new daily job receives first-run grace, but a previously missed run cannot produce a green recovery merely because today's grace window began.

Success means the pass completed without an uncaught infrastructure error, not that every per-item action succeeded. Item-level failures remain in their service ledgers. Behance and ElevenLabs have independent tables; Behance now stamps the observed job version after Slack accepts the existing-message update.

Five Vercel/Inngest jobs retain success-only telemetry. They cannot distinguish a failing tick from a stopped tick until attempts are added separately. Intentionally disabled transcript integrations are omitted rather than resurrected by historical timestamps.

Telemetry writes have two-second deadlines and are best effort for workers. A failed heartbeat/configuration read reports monitoring unavailable, not healthy. Enrollment writes do not count as successful job runs.

## Rollout

1. Run Node 22 tests, root/Bolt/tools typechecks, actual migration tests, migration integrity, lint ratchet and production build.
2. Apply additive heartbeat and retirement migrations before code deploy. Existing code remains compatible. No queue rows are retired by schema deployment.
3. Pass release gates and merge. Confirm Railway and Vercel deploy the same merged SHA; prefer Railway writers before watchdog. Persistent first-enrollment grace covers rollout overlap without resetting on future cold starts.
4. Verify worker-owned registrations and genuine attempt/success timestamps. Daily jobs newly enrolled after today's fire remain awaiting their next scheduled run, not “successfully executed.”
5. Apply only the frozen historical Fabric retirement manifest after dry-run validation. Preserve 2639 disabled and 2637 future uploads.
6. Verify production health/deployment evidence and record unresolved historical provider cases explicitly.

## Rollback

Keep additive migrations and audit history. Roll back application code only if required, but do not re-enable replay of retired revisions: the claim guard must remain, and the prior worker has no exact-revision retirement guard for newly ingested historical events. Prefer a forward fix or disable inbox intake temporarily with operator approval over restoring an unsafe old consumer. Never erase heartbeat/audit history to make health green.

## Tests

Regression coverage includes daily missed-run false recovery, disabled historical jobs, runtime timezone mismatch, exact retirement identity, atomic rollback, expired worker fencing, next-revision preservation, real database privilege checks, fail-closed retirement reads, and Slack acknowledgement ordering/version conflicts. See the pull request checks for final release results.
