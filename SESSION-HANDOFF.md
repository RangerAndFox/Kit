# Kit — Session handoff

Current as of 2026-08-31. Repository: https://github.com/RangerAndFox/Kit. Production Supabase project: `ozsxrcgrezpffnpwlrnq`.

## Current build state

Kit is a Slack-native studio operations system with a persistent Bolt service on Railway, Next.js/Inngest work on Vercel, Supabase as the durable source of truth, and optional studio render workers. Project creation, existing-project updates, outgoing-file Frame.io mirroring, storyboards, hours tracking, meeting briefings, knowledge retrieval, and render coordination are implemented.

The founder-only Kit Control Center is live at `/control-center`, via `/kit dashboard`, and via the strict bare `dashboard` DM shortcut. Its second layer adds live project drill-downs, guarded Canvas reconcile and Behance retry controls with audit records, Vercel/runtime version visibility, measured API cost totals, and explicit instrumentation gaps. The dedicated Behance Mac profile is authenticated; its LaunchAgent is installed from `kit-behance-worker`, runs from Application Support, starts automatically at login, and reports an idle live heartbeat plus Chrome version. Project 2699 supplied the live archive proof: Dropbox archive/media generation, unlisted Vimeo, Buffer LinkedIn/Instagram drafts, and a private Behance draft with structured website copy and approved media all completed. WordPress remains the only archive provider awaiting an operator-assisted final proof through the designer-provided entrance.

The main implementation risk is no longer a known code failure. The application, persistent Slack service, agent layer, and maintenance scripts compile under strict TypeScript without file-level suppression. Live Supabase types are checked in, runtime tables are migrated, and the release suite is green. A studio render worker is online with a current heartbeat, After Effects capability, and a prior Dropbox → Frame.io output. A fresh expensive render was not queued during the August 31 certification because the existing live artifact plus current worker health already proved the path.

## August 31 completion pass

- Removed every remaining `// @ts-nocheck` directive from `src/`, `bolt/`, `agents/`, and `scripts/` (154 files across the cleanup); the repository now contains zero file-level TypeScript suppressions.
- Added a single root `npm run typecheck` command covering the Next.js application, strict Bolt service, agents, and maintenance scripts.
- Generated `src/types/supabase.ts` from the live production project and repaired stale table/column assumptions uncovered by strict typing.
- Added and applied service-only, RLS-enabled migrations for `managed_agent_sessions` and `celebrations`, including the session project lookup index. Supabase's security advisor reported no findings after the schema changes.
- Fixed typed check-in replies so the acting Slack user is passed into confirmation authorization; corrected project, milestone, call-classification, knowledge-action, Dropbox, Frame.io, and Canvas mappings to the live schema.
- Replaced the obsolete Plaud signature probe with a current client/parser smoke test.
- Verified 794 application/agent/script tests and 460 Bolt tests: 1,254 passing in total.
- Verified the production build with Next.js Webpack, both dependency audits at zero vulnerabilities, and all 103 migration files through the migration guard.
- Reduced the guarded ESLint debt from 1,503 errors / 91 warnings to 1,264 errors / 87 warnings. The remaining lint findings are non-blocking legacy cleanup protected by a ratcheting baseline; new regressions fail CI.

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

- The Google Sheet “RF Production System — Canvas Control Center” is the producer-facing source of truth for Overview, Reference, Schedule, and Notes & Feedback canvases.
- New project provisioning writes the project into Projects, Project Specs, Links, Deliverables, Status Log, and Workback as applicable; provider-created Dropbox, Frame.io, and Boords links flow back into the workbook and generated Slack canvases.
- The Status Log now has a strict `Visibility` field. Only rows explicitly marked `Team` may render in Notes & Feedback; blank or `Private` rows fail closed.
- Existing projects missing a generated view are repaired even when the source-row hash is unchanged. Slack accepted the backfilled Notes & Feedback canvas with channel access for test project 2697, but did not add it to that historical channel's visible tab strip; Slack exposes no separate public API for forcing that attachment. New-project provisioning is the supported four-tab path.
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

No known repository or database blocker remains. The full August 31 product certification passed 1,254 automated tests, production build/type/security checks, live Slack shortcuts, project 2697 create/update/share/workback flows, project 2699 archive drafts, Storyboard + ElevenLabs provider jobs, and current worker health. Remaining provider/operator boundaries are listed in `OPERATOR-TODO.md`; they are not core cloud-software failures.

## Verification commands

```bash
npm run typecheck
npm run lint:ratchet
npm run check:migrations
npm test
npm audit
cd bolt && npm test && npm audit
npx next build --webpack
```
