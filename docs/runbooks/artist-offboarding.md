# Project-specific artist offboarding

## Producer workflow

1. DM Kit `offboard an artist`, say `Kit remove Alex from project 2637`, or use `/kit offboard`.
2. Choose the exact project, then the artist from its onboarding history. A name in a message is only a hint, never a removal target.
3. Review the private card. Choose **Offboard**, **Edit**, or **Cancel**. Confirm the removal when prompted.
4. Read every service result. **Retry failed steps** retries only unresolved services; verified removals are not repeated.

The feature requires an active producer/admin identity on every action. Cards belong to their requesting user and verified workspace; a new review expires after 30 minutes. Onboarding and offboarding share a durable project/person lock.

## Removed versus retained

- Removes verified direct project membership/invitations from Slack, Dropbox and Frame.io, and the project-specific Kit dashboard grant.
- Slack Connect members are removed individually from the verified, studio-hosted project channel. Kit matches the exact email, removes only that channel/user membership, and verifies absence. It never disconnects an external organization or removes someone from other channels or DMs.
- Non-hosted Slack Connect channels, public-channel access for internal members, inherited group/workspace access, missing identities, provider outages and ambiguous invitations require manual review. Kit never removes organization-wide access.
- Preserves the global People/staff record, other projects, files, comments, messages, NDA history, credits and all time records. Harvest's shared Freelancers bucket is intentionally retained.
- Past Daily Assignments remain unchanged. Today/future or undated assignments appear **Unassigned — Needs reassignment** in the generated canvas. Source rows remain intact for history. The sheet Add row form excludes the person only for the offboarded project.
- Existing shared links and downloaded copies cannot be recalled by membership removal. Review those separately; Kit does not revoke a link used by other people.

## Recovery and re-engagement

An interrupted onboarding remains held for administrator reconciliation rather than allowing a second process to grant access during removal. A failed removal preserves its durable service results and can be retried from the original private card. A request held by a lost worker becomes retryable after its ten-minute lease expires.

Automatic re-onboarding into the **same** offboarded project is intentionally blocked pending administrator reconciliation of the old request, memberships and assignment exclusion. Other projects remain available. Do not clear an access hold just to silence a warning; first verify no old provider request is still running.

## Deployment

1. Apply `20260914202955_artist_project_offboarding.sql` before the new Bolt code. Verify public/anonymous access is denied and audit rows cannot be updated/deleted by the service role.
2. Deploy both runtimes from the tested commit. Confirm only the new Railway worker owns side effects and Slack connectivity is healthy.
3. Update the bound Apps Script from `scripts/apps-script/project-control-sheet-edit.gs` **only** on the authoritative workbook `1qF690PLEK-NrzNUywwkEY-SAzt3pgRc8dG8UzAXeGyo`. Preserve its manifest, properties and triggers. Do not run setup or change source rows.
4. Test the private picker then cancel. Do not remove a real freelancer merely to test a release.

Assignment exclusions are service-written spreadsheet developer metadata (`kit_artist_offboarded`), containing project number, display name, engagement ID and historical cutoff—not email or private notes. Sheet edits still use the normal canvas sync; the projection does not change historical cells or the global People roster.

## Automated verification

`node scripts/test-artist-access-database.mjs` executes the actual migration in an isolated Postgres runtime with synthetic identities and tests RLS, role/tenant boundaries, immutable audit permissions, stale cards, competing workers, partial failures and retries. Provider, routing, assignment-history and Apps Script tests use synthetic fixtures; these are not proof of live provider permissions.
