# Notification and health recovery — 2026-09-25

## Scope and mechanisms

- Railway ElevenLabs notifications resolve a user ID through `conversations.open`, using the existing hours-reminder pattern. Explicit project channels/threads never silently redirect.
- Claim/hold checks fence posting and acknowledgement. Slack history is paginated for persisted job-marker reconciliation; unknown history is not permission to repost. One job failure does not abort the batch, but any failure still fails the cron.
- Notification disposition is distinct from provider-job status and `slack_notified_at`. `manual_review` and `retired` are operator decisions, not successful delivery. No public route can change them.
- Vercel monitor configuration writes and heartbeat reads run independently. Both monitoring keys explicitly recover. Stage-only logs contain no provider payloads or secrets.
- Project upload settings fail closed on a database read failure, rather than re-enabling disabled uploads.

## Approved historical cleanup (production)

The owner confirmed Fabric 2637 and Jimmy Kimmel 2639 were delivered and requested no re-upload. Applied an exact-manifest, locked, audited transaction after a rollback rehearsal:

- 28 Jimmy Kimmel processing transfers and 16 Fabric failed transfers retired through the existing retirement RPC, with 44 corresponding inbox records fenced.
- 34 Jimmy Kimmel dead-letter inbox events retired with append-only receipts.
- Frame.io mirroring disabled for the two exact project records. Delivered media, successful transfer rows, other projects, and project history retained.
- Two old ElevenLabs E2E notification jobs retired; two September 2 failed jobs (2641 NYCC and 2632 Copilot Web Animations) held for manual review. All four retain NULL notification timestamps; no old message was sent.
- Verified zero remaining non-ready/unretired transfers and zero unfinished/unretired inbox events for those projects.

Migration `20260925134654_notification_dispositions` was tested against PGlite and applied before the new worker. It is additive. Audit rows are RLS-protected, service-only and append-only; no credentials or signed URLs are stored in them.

## Validation and rollout

- Root/Bolt/tools typechecks; 907 app tests and 973 Bolt tests passed.
- Production webpack build passed; migration ledger 121 files; lint debt decreased, no new warnings.
- Tests cover real DM resolution, explicit-channel failures, batch isolation, holds, lost claims, failed acknowledgements, history pagination, monitor read/write outages and recovery, settings fail-closed, audit permissions and disposition constraints.
- Production release still requires platform deployment and heartbeat verification; repository checks alone are not proof of rollout.

Do not undo historical dispositions to roll back code. Preserve the migration and audit records. A previous worker version does not honor notification holds; prefer a forward fix and never automatically resend historical notifications.
