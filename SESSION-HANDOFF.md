# Kit — Session handoff

Current as of 2026-08-21. Repository: https://github.com/RangerAndFox/Kit. Production Supabase project: `ozsxrcgrezpffnpwlrnq`.

## Current build state

Kit is a Slack-native studio operations system with a persistent Bolt service on Railway, Next.js/Inngest work on Vercel, Supabase as the durable source of truth, and optional studio render workers. Project creation, existing-project updates, outgoing-file Frame.io mirroring, storyboards, hours tracking, meeting briefings, knowledge retrieval, and render coordination are implemented.

The main implementation risk is no longer a known code failure; it is deployment/provider verification. Vercel checks passed on the latest merged work. Railway could not be inspected in the final audit because its connector repeatedly restarted authentication.

## Work completed in the August 20–21 sequence

### Existing-project updates

- `update project` and `/kit update` open a card analogous to the new-project provisioner.
- The selected project's current values prefill the modal.
- Confirmed edits ripple through the connected services and the Master Project List using durable request/step ledgers.
- Retryable partial updates recover from Railway's five-minute sweep; unrecoverable failures are surfaced as needing attention.
- Provider-created suffixes such as `cd227d7a` no longer leak into human-facing project names.
- The picker reconciles editable Supabase rows with live, non-archived Slack project channels. Live channels missing from Kit can be adopted/relinked; deleted test channels are not shown merely because an old database row exists.

### Slack project provisioning/update resilience

- Slack create/rename behavior was hardened and covered by focused tests.
- Project identity and channel bindings remain stable across updates.
- Shortcut routing now has one canonical `DM_SHORTCUT_REGISTRY` used by both Slack's Assistant callback and the plain-message fallback. This prevents a strict card command from working on only one inbound path and falling through to a generic answer on the other.

### Storyboards

- The Railway build includes `mammoth`, restoring `.docx` extraction.
- Long Boords operations persist resumable job state and return `/storyboard resume <job-id>` on timeout rather than losing progress.

### Dropbox → Frame.io

- Project outgoing-file mirroring is confirmed working for uploads under `/production/.../09_Outgoing/{01_Client Progress,02_Delivery}`.
- Share creation was corrected to Adobe's documented Frame.io V4 contract: `POST /accounts/{account}/projects/{project}/shares` with a public asset share and `asset_ids`.
- A provider-contract regression test locks the endpoint and payload. The existing file-view fallback remains in place.
- Project `2633-Microsoft / Biz Apps` is a known partial record: Slack, Dropbox, and Harvest are linked; Frame.io is missing. The watcher should discover/backfill it on the next eligible delivery.

### Hours tracking

- Daily reminders are durable per `(staff, local workday)`, delivered by an hourly timezone-aware sweep, reconciled after ambiguous Slack sends, and protected against overlapping-sweep duplicates.
- The `daily_hours_reminders.check_in_id` lookup now has a production migration/index (PR #136).
- The historical Allyson July 31/August 10 over-log remediation is already applied. The check-ins point to the corrected 2-entry and 4-entry Harvest sets; do not rerun the one-off repair.

### Meeting briefings

- Bizdev, kickoff, and active-project briefings now share the simplified layout requested by the studio:
  - Meeting info
  - Attendee info (external attendees only, with LinkedIn/web evidence when available)
  - Positioning (a natural-language Ranger & Fox partnership paragraph)
- Private delivery remains the default. Research failures degrade to explicit fallback copy rather than fabricated biography.

### Dependency/security state

- Bolt dependencies were upgraded in PR #139.
- `npm audit` in `bolt/` moved from 12 advisories (1 critical, 6 high, 4 moderate, 1 low) to zero.
- Vitest is 4.1.11 and tsx is 4.23.12.
- The post-upgrade suite passed: 45 test files and 398 tests before the shortcut test consolidation; 45 files and 396 tests after replacing six duplicate parity assertions with four registry assertions. TypeScript validation is clean.

## Merged pull requests in the final pass

- PR #136 — index daily-hours reminder check-in lookup
- PR #137 — simplify and improve meeting briefings
- PR #138 — repair Frame.io V4 public share creation
- PR #139 — update Bolt dependencies and clear npm advisories
- PR #140 — unify Slack DM shortcut routing

All were squash-merged to `main` after local tests and passing Vercel checks.

## Runtime ownership

- Railway owns Slack Socket Mode, `/webhooks/dropbox`, project outgoing-file mirroring, daily-hours/reminder jobs, project create/update recovery, and other in-process Slack jobs.
- Vercel/Inngest owns meeting scans/dispatch, `/Delivery-Queue` polling and delivery workflow jobs, transcript ingest, health checks, studio-knowledge jobs, and Master Project List → Canvas convergence.
- Supabase owns shared records and durable workflow ledgers.
- Studio workers own FFmpeg transcodes and Deadline relay execution.

The Railway Dropbox webhook and the Vercel `/Delivery-Queue` poller are not duplicates. They watch different roots and implement different workflows. See `.ai/runtime.md`.

## What remains

Everything currently safe to implement in the repository has been merged. Remaining work requires a live event, provider/dashboard access, a studio machine, or a product decision:

1. Verify Railway deployed current `main` and is healthy.
2. Verify the next outgoing file produces a real public Frame.io share.
3. Verify project 2633's missing Frame.io ID auto-backfills on that event.
4. Observe the next local-5pm hours occurrence end to end.
5. Observe the next real simplified meeting briefing.
6. Confirm studio delivery/render workers before depending on transcodes.
7. Resolve the visibility and briefing-posting decisions in `OPERATOR-TODO.md`.

## Verification commands

```bash
npm run build
cd bolt
npm ci
npm test
npx tsc --noEmit
npm audit
```
