# Health monitoring reconciliation — 2026-10-08

## Evidence and cause

The 09:00 ET digest reported a 10-second Supabase probe timeout and a failed
schedule registration. Production Vercel logs recorded a configuration-write
timeout at 13:00:29Z (5,025 ms). Subsequent persisted checks were healthy.
This proves unavailable monitoring at that moment, not a stopped worker or a
confirmed database outage. Supabase API timeout logs corroborated transient
request failures, but did not isolate the network/database cause.

The heartbeat reader retried; the integration probe and registration did not.
The daily digest also never saved incident state. A digest-only incident could
therefore recover without the watchdog ever knowing an alert had been sent.

## Invariants and change

- One fresh retry for transient live transport failures; deadlines remain
  bounded and cancellation signals are fresh. Authorization, missing config,
  and recorded manual-review job failures are not retried or downgraded.
- `unknown` is an explicit health state, not evidence of either success or
  failure. Slack and the dashboard show it as a warning. Missing telemetry
  cannot render a fabricated fresh-cron count. Registration never stamps a
  successful worker completion.
- The two existing Inngest functions publish through one shared env-scoped
  concurrency step. Inngest concurrency applies to steps, not whole functions;
  all queue delivery and completion operations stay within that single step.
- `health_reports` durably retains immutable delivery plans. Existing Slack
  receipts reconcile an accepted message after a crash rather than posting it
  twice. SQL commits incident state and report completion atomically only
  after successful delivery, or for a silent unchanged result.
- Pending reports drain oldest-first, capped at 20 per invocation. A failure
  stops later state changes. An ambiguous Slack send remains held for receipt
  reconciliation/manual review; it is never blindly resent. The existing
  delivery acknowledgment probe detects stalled receipts.
- Snapshots older than recorded `checked_at` cannot reopen incidents. Both
  digest and watchdog can close a recorded incident and report its recovery.
- Both destinations resolve to the existing private Kit DM. Public channels
  are refused. No check-in dates, Harvest entries, upload queues or delivered
  media are changed by this fix.

## Release and rollback

Apply the additive migration before deploying the new application. It permits
the legacy up/down values and adds a service-role-only reporting table/RPC.
Coordinate the Vercel cutover away from an executing old watchdog: the old
version does not participate in the new shared publication concurrency key.
Verify Inngest sync, a new watchdog report completed, and matching health rows.
Do not synthesize outages or send test failure messages to the owner's DM.

If rolling back, retain the migration and pending report rows/Slack receipts.
Never delete an ambiguous receipt to force resend. Old code cannot provide
the new digest/recovery guarantee; reconcile pending plans before re-enabling
the old reporter. This change introduces no cron or external provider writes
beyond the existing private health reports.

## Verification

Focused tests cover retry success/exhaustion, no retry of a stored timeout,
unknown/failure/recovery transitions, digest → watchdog recovery, duplicate
observations, late snapshots, send failure, post-send commit failure, shared
step serialization, and private DM resolution. PGlite executes the actual
migration and checks atomic rollback, replay, monotonic timestamps and grants.
Repository release gates and platform verification must be recorded separately.

Local release validation: Node 22.23.3; 952 app tests and 1,051 Bolt tests
passed; all three typecheck configurations passed; lint ratchet did not grow;
131 migration files validated; production Next.js build passed. The new
snapshot uses a versioned step ID, avoiding replay of the old array-shaped
`run-checks` output as a timestamped snapshot.
