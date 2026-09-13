# All-command natural-language routing — verification

## Scope

Every registered `/kit` family (including aliases and pilot subcommands) plus `/storyboard` is represented in a tested command catalog. The existing orchestrator translates loose natural requests into an allowlisted command review card. Fast paths cover common phrasing. The same registered slash handler executes only after a real user clicks Continue. Existing hours, upload, project-selection, publishing and typed-deletion safeguards remain.

## Verified before release

- Full Bolt suite: 750 tests passed across 64 files.
- All workspace TypeScript checks passed; no added ESLint debt.
- Catalog coverage is checked against every actual switch case and storyboard registration.
- Model command input cannot supply actor/team/destination IDs or arbitrary command names; sibling specialist calls do not execute alongside an offered command.
- Runtime tests cover every command offer, artist/admin gates, role revocation, private output, failed DM routing, Slack rejection, duplicate message/card clicks, cancellation, expiry, fresh triggers, and uncertain results without replay.
- Real slash-handler registration and help/resume validation are exercised without external provider calls.
- Fixed a discovered bare `storyboard resume` bug: it now asks for a job ID instead of trying to resume a job literally named `resume`.
- Fixed mention handling so role/birthday targets survive app mentions and relay-attribution cleanup. Added rejection of negative/conditional role and upload mutations.
- Database migration tested in a rolled-back transaction, then applied as `20260913194450_natural_command_requests`. Read-back confirmed RLS enabled, no anon/authenticated grants and service-role claim access. Actor mismatch, replay and expiry tests passed without retaining test data.
- Existing RLS-without-policy INFO notices are intentional for service-only tables; no public policy is added just to silence the advisor.

## Deployment boundary

The owner explicitly authorized bypassing independent review for this release. Use the existing OrganizationAdmin bypass only after all automated release checks pass; do not falsify a review/check status or disable standing protections. Verify both the Railway Bolt commit/Slack-connected health and Vercel production deployment after merging. Repository tests alone are not proof of a live rollout.
