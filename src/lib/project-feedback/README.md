# Project asset feedback

The existing Sheet→Overview sync registers links from the same team-safe Assets
allowlist used by the Overview. `projectFeedbackSync` is the **only** importer.
It polls at most five due files every five minutes, normally once per file per
hour, with provider rate-limit backoff. This is eventual sync, not an instant
webhook. Figma/Script/reference rows support multiple URLs in the Overview.

## Scope and presentation

- Figma file comments/replies and resolution, from a direct design/prototype/
  FigJam/Slides file link in Assets.
- Google Docs file comments/replies/resolution, via Drive's comments API.
- Saved Word `.docx` embedded comments, including modern reply/resolution data
  when the file contains it, from direct Dropbox or Drive file links. Drive-hosted
  Word files also include Drive's separate file comments. Legacy Word comments
  without resolution metadata show **Unknown**, not incorrectly Open/Resolved.
- H3 source headings, Unicode source icons, author, Pacific date, status and
  original-file link. At most 40 threads/11 entries per thread and a 25KB row
  budget; long comments show an 800-character excerpt with a continuation label.
  Full snapshots stay private; omitted comments remain available at the source.
- The importer does not resolve, reply to, or edit source comments. It does not
  read document body links, financial/Other/Harvest assets, or Last Share.
- **Direct document links required.** No recursive folder crawling, `.doc`, PDF,
  OneDrive/SharePoint native comments, or Dropbox website comments. General
  project-folder rows are ignored; a Script folder gets an explicit direct-file
  warning. Saved Word comments are distinct from Dropbox website comments.

## Safety and retries

The service-role-only table stores source snapshots, publication hashes, next
attempt and expiring claim tokens. Registration is atomic; removals invalidate
in-flight tokens. Exactly one live claim can publish a source; every write checks
ownership. Slack sections are found by a collision-checked `Kit-<12 hex>` marker
and section type before every edit. Each request has one edit operation. A retry
after an ambiguous write looks up the marker before inserting again. Duplicate
markers fail closed for manual review. This is reconciliation, not a claim of
cross-service exactly-once transactions.

Only those two Kit-managed sections can be replaced. Human notes outside them
are preserved. Do not write team notes inside an imported table: it is a generated
projection. Removed sources replace their imported comments with a stopped-
tracking notice; prior snapshots remain private for history. Archived/non-active
projects and missing authoritative Sheet rows withdraw source registrations.

Errors show a stale-data warning without discarding the last good comments.
Missing canvases retain a private error for retry. Provider bodies, tokens and
signed share URLs are never logged. Fetch destinations are fixed provider APIs;
redirects are rejected. DOCX download, ZIP expansion and XML/comment sizes are
bounded and entity declarations rejected. One failed source must not overwrite
another source or the complete canvas.

## Activation (not automatic with deployment)

1. Pass normal release gates and apply migration
   `20261010132354_project_feedback_sources.sql`. It is additive; no existing
   project, canvas, file or Brain is deleted or modified by the migration.
2. Verify the Vercel production service has working Google service-account,
   Dropbox refresh credentials and Slack bot credentials with canvas read/write.
   Share each direct Drive document with the service account. Verify Dropbox
   scopes permit shared-link metadata and file content reads.
3. Configure server-only `FIGMA_COMMENTS_TOKEN` through the deployment secret UI
   with `file_comments:read` and access to the intended files. Never paste it in
   a chat or commit it. A Figma connector in an operator chat is not Kit's token.
   Respect token expiry/rotation and plan-dependent rate limits.
4. Set `PROJECT_FEEDBACK_SYNC_ENABLED=true` only after a controlled pilot can
   run; deploy production and verify Inngest registration. Preview stays inert.
5. Refresh the pilot project's existing Project Control sync to seed the queue;
   changing an env flag alone does not change the workbook's version cursor.
6. Verify a live example from each provider: root comment, reply, resolved
   thread, source edit, access denial, and removal from Assets. Confirm existing
   manually written Slack notes are unchanged; repeat once to prove no duplicate
   sections. Local fixtures do **not** prove these live API contracts.
7. Inspect private `error_code`, `checked_at`, and `next_attempt_at` after the
   first run. Do not call the feature live until the relevant providers pass.

Rollback: unset the flag and redeploy; keep the additive schema and receipts.
This stops reads/writes without deleting source files or existing team notes.
Imported sections remain at their last snapshot until manually reviewed.

## Validation

`node --import tsx --test src/lib/project-feedback/feedback.test.ts scripts/project-feedback-database.test.ts`
tests fixtures, provider failure paths, private grants, atomic claims, stale
worker rejection, bounded text and section reconciliation. Also run Project
Control tests, app suite, Bolt suite, typecheck, migration integrity, lint ratchet
and production build. No production configuration or source content is needed.
