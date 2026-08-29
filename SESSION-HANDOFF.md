# Kit — Session handoff

Current as of 2026-08-29. Repository: https://github.com/RangerAndFox/Kit. Production Supabase project: `ozsxrcgrezpffnpwlrnq`.

## Current build state

Kit is a Slack-native studio operations system with a persistent Bolt service on Railway, Next.js/Inngest work on Vercel, Supabase as the durable source of truth, and optional studio render workers. Project creation, existing-project updates, outgoing-file Frame.io mirroring, storyboards, hours tracking, meeting briefings, knowledge retrieval, and render coordination are implemented.

The founder-only Kit Control Center is live at `/control-center` and via `/kit dashboard`. Its second layer now adds live project drill-downs, guarded Canvas reconcile and Behance retry controls with audit records, Vercel/runtime version visibility, measured API cost totals, and explicit instrumentation gaps. The dedicated Behance Mac profile is authenticated; its LaunchAgent is installed from `kit-behance-worker`, runs from Application Support, starts automatically at login, and reports an idle live heartbeat plus Chrome version. The Behance package now uses the exact approved website copy and places title/subtitle, body sections, Process, and credits as separate modules around the appropriate media, matching the reference portfolio structure. A complete approved-project archive/Behance draft remains the final provider-side proof.

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

### Project Control workbook and canvases

- The Google Sheet “RF Production System — Canvas Control Center” is the producer-facing source of truth for Overview, Reference, and Schedule canvases.
- New project provisioning writes the project into Projects, Project Specs, Links, Deliverables, Status Log, and Workback as applicable; provider-created Dropbox, Frame.io, and Boords links flow back into the workbook and generated Slack canvases.
- Native Google Sheets tables on Projects, Project Specs, and Workback now expand atomically with Kit's write. The existing test project rows were repaired into those tables; plain filtered-range tabs already cover the full working grids.
- Workback state and latest-share fields converge from the Dropbox → Frame.io automation, and sheet edits trigger canvas refreshes rather than requiring canvas edits.

### Storyboards

- The Railway build includes `mammoth`, restoring `.docx` extraction.
- Long Boords operations persist resumable job state and return `/storyboard resume <job-id>` on timeout rather than losing progress.

### Dropbox → Frame.io

- Project outgoing-file mirroring is confirmed working for uploads under `/production/.../09_Outgoing/{01_Client Progress,02_Delivery}`.
- Share creation was corrected to Adobe's documented Frame.io V4 contract: `POST /accounts/{account}/projects/{project}/shares` with a public asset share and `asset_ids`.
- A provider-contract regression test locks the endpoint and payload. The existing file-view fallback remains in place.
- Project `2633-Microsoft / Biz Apps` is now proactively linked to Frame.io. PR #147 added startup/hourly reconciliation for active Dropbox-linked projects, and production persisted Frame.io project `e52092ec-336c-4744-a2f7-e5dbd1fb2766` on 2026-08-21 without requiring a synthetic delivery file.
- Delivery Queue Slack prompts now remain retryable until Slack confirms the notification; a failed post is no longer silently marked complete.

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

### Meeting transcripts and studio knowledge

- Direct Plaud OAuth polling is enabled in production; the Drive fallback is disabled to prevent duplicate ingestion. Token rotation is coordinated in Supabase and the explicit historical frontier prevents replaying older Drive imports.
- Raw Plaud/Drive transcripts are founder/admin-only even after project matching. Project matches receive a separate deterministic `call_transcript_safe` derivative with financial, contact, credential, contractual, legal, personal, URL, and named-speaker lines removed.
- Shared Slack participation does not receive transcript context at all. Non-DM replies also pass through a final deterministic sensitive-content guard; artists remain blocked from the studio-knowledge surface.
- Production was corrected on 2026-08-27: all 1,509 historical raw transcript chunks are founder-only and zero remain team-visible. Auto-generated team summaries read only the safe derivative, never the raw transcript.
- Semantic search receives a server-resolved requester tier and enforces allowed visibility inside `match_documents`.

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
- PR #147 — reconcile missing Frame.io links and retain failed delivery notifications

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
3. Observe the next local-5pm hours occurrence end to end.
4. Observe the next real simplified meeting briefing.
5. The studio delivery/render worker is intentionally deferred until an always-on studio machine is selected; production currently has zero registered workers.
6. Resolve the visibility and briefing-posting decisions in `OPERATOR-TODO.md`.

## Verification commands

```bash
npm run build
cd bolt
npm ci
npm test
npx tsc --noEmit
npm audit
```
