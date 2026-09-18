# Client Progress notification routing — September 18, 2026

## Incident and invariant

2638's September 18 Client Progress video uploaded successfully. Folder-name
lookup missed the existing migrated project and created an unbound duplicate.
The duplicate had neither producer nor channel routing. Its durable share event
was pending, with no Slack message timestamp. Missing routing returned normally,
so recovery could incorrectly count it as recovered.

One project identity must own uploads, Sheet/Canvas bindings and notifications.
Retries must not create a second project or re-upload existing media. Existing
analogous behavior: `resolveFrameioIdForProject` reconciles a missing provider
link by project number; the transfer ledger avoids repeating accepted uploads.

## Live repair (verified separately from code deployment)

- Original project: `31c306e9-53c1-4278-923f-a7135d9507a0`.
- Discovery duplicate: `4194a750-1a96-4f69-8506-e4714b290c6b`.
- Moved both completed transfer checkpoints, the folder share and the share
  event to the original. No media/provider operation was performed.
- Linked the original to its existing Frame.io project and Dropbox folder name.
- Set Jennifer's verified producer identity, matching Projects.Producer.
- Archived the duplicate as `merged:2638:4194a750`; retained original identity
  details, merge target and reason in its external_ids audit metadata.
- User explicitly declined a resend. Event
  `4f3f075e-6e40-4a8a-a251-ee68ecaa3d77` is `dismissed`, with the requesting
  administrator recorded and Slack timestamp still null. No fake send receipt.
- Reconciled 18 additional bound project producer IDs against the authoritative
  workbook: 2520, 2611, 2618, 2625, 2626, 2627, 2629, 2630A–E, 2631,
  2633, 2635, 2639, 2640 and 2701. Includes 2629's stale producer assignment.
- Upload-enable settings, files, Slack memberships, and Sheet contents untouched.

## Audit scope and unresolved data

Inspected all 259 project records, all 30 authoritative-workbook bindings,
current Projects rows and the pending unsent share-event queue. Before repair,
30 non-archived/non-completed DB records lacked producer IDs; 15 also lacked a
channel. Those counts include legacy/test/discovery records, not 30 current
production assignments. After dismissing 2638, no pending unsent share events
remained. This is a point-in-time audit, not a guarantee of future provider uptime.

Nine other project numbers occur more than once: 2520, 2601, 2602, 2609, 2610,
2611, 2614, 2624, 2630A. Do not merge by number alone: 2520 includes archived
Icertis and active Coffee / Espresso. Several others are archive/import pairs;
2601, 2611 and 2630A each have the same Frame.io ID on both records. They need
explicit canonicalization and transfer/history reconciliation before any merge.
The new watcher fails visibly on ambiguous matches, rather than guessing.

Projects.Producer is blank for 2601, 2609 and 2624; the first two are completed
in the Sheet. 2624 is active in the Sheet and needs an explicit producer there.
Existing database producer IDs were not used to invent missing Sheet values.

## Code protection

- Resolve Slack's authenticated team to exactly one workspace, then find exact
  project-number candidates within that workspace. Preserve letter suffixes.
- No project insertion from Dropbox/Frame.io folder discovery. Unknown and
  ambiguous identities fail before an upload, retaining queue retry/review state.
- Before notification, read the bound authoritative Sheet Producer and resolve
  only an active producer/admin. No fallback to artist channels or arbitrary DMs.
- Persist verified producer routing for downstream authorization consistency.
- Respect dismissed/already-sent events and require Slack acknowledgement before
  writing the send receipt. Missing routing throws and remains recoverable.
- Health probe includes pending unsent folder notifications older than 15 minutes,
  not just dead-lettered uploads; dismissed events do not trigger it.

## Verification

Regression tests exercise renamed folders, unknown/duplicate/suffixed project
numbers, merged records, producer changes and aliases, ineligible recipients,
Google outage, Slack rejection, wrong workbook, explicit no-resend, and overdue
notification health. They use mocked providers: no production upload or DM was
used for testing. Deployment status must be verified independently in Railway
and Vercel; passing these tests alone is not deployment evidence.
