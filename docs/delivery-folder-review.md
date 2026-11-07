# Delivery folder review

## Behavior

`02_Delivery` approvals use one durable private producer/creative-director card
per project and root delivery folder. The root is the first directory beneath
`02_Delivery` (for example `110626`), or `02_Delivery` itself for files placed
directly in it. Nested videos, captions, stills and manifests share that card.
Later arrivals and outcomes quietly update its existing Slack receipt.
`01_Client Progress` retains its existing logical-file workflow.

The card opens a ten-file page of current logical-file heads. Each awaiting file
has its own Review & rename and Skip actions. Review opens the existing exact
revision/name confirmation form above the folder view. Closing or cancelling a
form does not approve anything. Close the individual form and Refresh the folder
to see the latest state. There is no bulk approval or folder-wide rename.

File approval identities, source verification, rename intent, destination
reservation, collision ownership, transfer receipts and version history are
unchanged. A duplicate still goes only to its original approver's private DM.
Package completion updates the existing card, without a separate completion or
workback-advance Slack prompt. Completed files expose their stored, scoped Frame
folder share link inside the review. Share/transfer records and Latest Share Sheet
recovery remain durable. No workback milestone is automatically advanced.

## Persistence and safety

- `frame_upload_review_packages` owns only the notification, with a scoped
  workspace/project key and a separate lease and dirty generation.
- Package pages authorize the authenticated Slack team and current project
  reviewer before loading paths or names. Individual actions reauthorize and
  keep their existing exact-state checks.
- Every new package uses one durable Slack delivery key. Unknown send outcomes
  reconcile that key rather than inventing a new one. Recovered receipts are
  quietly refreshed before acknowledging the rendered generation.
- The migration adopts a compatible existing file-card receipt. Active awaiting
  packages with a saved anchor are quietly refreshed; completed-only history is
  not replayed. Other active per-file controls are quietly retired with a
  lease-fenced cleanup checkpoint; original receipts are never cleared.
- Mixed private reviewer groups or legacy channel-only receipts fail closed.
  They need manual reconciliation of the existing send, never a blind repost.
- `project_share_events.notification_disposition='package'` records intentional
  suppression, not a fabricated Slack receipt. Sheet failures remain retryable.

## Approval-gated rollout

This branch is not deployed. Do not merge, apply the migration, restart or deploy
production without rollout approval. Green local checks do not verify production.

After approval:

1. Recheck main and all required PR checks. Verify the actual Railway deployed
   source SHA and target Supabase project. Read-only preflight should count active
   review slots, compatible anchors, mixed groups and channel-only receipts.
2. Quiesce the old Bolt sender and drain in-flight notification work before schema
   migration. Do not run old and new senders concurrently: an already-running old
   process can still POST a per-file card. Do not discard Dropbox inbox events,
   transfer records, approval rows or Slack receipts.
3. Apply `20261107120000_frame_upload_review_packages.sql` using the normal
   migration path. Verify scoped package membership, blocked reasons and adopted
   receipts. Resolve uncertain legacy outcomes from their existing durable
   delivery records before clearing any block, with separate authorization if
   private recipients would change.
4. Deploy the tested commit to Railway and verify the exact active SHA, health,
   Slack connectivity and the scheduled inbox/review/share recovery jobs. Resume
   normal processing only with the new sender active.
5. Verify existing active cards update in place and per-file controls retire,
   without sending synthetic production test messages or re-uploading assets.
   Observe the next genuine authorized upload: one root-card receipt, unchanged
   file approvals and transfer receipts, no extra package completion post.
6. Verify Latest Share recovery and original-approver collision handling with
   read-only records. Do not exercise a destructive duplicate decision as a test.

## Rollback

Stop the new sender before any rollback. Keep the additive schema and all
receipts. Do not blindly restart the old notification implementation: it would
resume per-file posts and does not understand package ownership. Prefer a
forward fix or keep notification processing paused until a compatible rollback
is reviewed. Never erase delivery ledger entries to force a retry.
