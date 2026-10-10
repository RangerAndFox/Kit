# Producer/CD review before Frame uploads

## Behavior

Railway remains the sole `/production` Dropbox observer. With
`FRAMEIO_UPLOAD_APPROVALS_ENABLED=true`, a new Client Progress or Delivery
revision is checked for source stability and a finalized media container before
Kit creates a durable review request. It does **not** create Frame folders,
rename the Dropbox file, upload, announce a delivery, or advance a milestone.
Previously accepted transfers continue through their existing ledger.

One private group DM includes the project's producer and CD (one recipient if
only one is assigned). Either may review an editable `R&F_Client_Project_Phase`
filename, confirm the export is finished, and approve the exact final name.
Unknown phases require editing; Kit does not invent a phase from the date.

- Initial review asks for the filename and render readiness only, not a default
  replacement policy. Approval atomically locks in the reviewer and filename.
- The worker checks the exact mirrored destination folder. No matching name
  means upload normally. A case-insensitive same-name match pauses before any
  rename or upload and DMs **only the original approver** (not both reviewers).
- The collision form has no preselected choice: Replace adds a version,
  retaining the previous file and comments; Keep both previews a distinct
  numbered filename (`_02`, `_03`, etc.); Skip leaves Dropbox/Frame untouched.
  Ambiguous multiple matches never offer Replace. If the match disappears,
  the approver can explicitly upload the original name or skip.
- Collision decisions are approver- and version-fenced in the database; stale
  forms and the other reviewer cannot take over. The shared card shows status
  without collision controls. The private card uses a durable receipt and
  updates in place after the decision.
- Every decision is atomic. Repeated clicks cannot enqueue two uploads.
- Competing producer/CD submissions preserve the first committed filename and
  reviewer. A stale form cannot overwrite the winning decision. The losing
  reviewer sees who approved and which name won. The existing shared card is
  refreshed immediately when possible, removes its action buttons, and shows
  the approver and approved filename; the durable outbox retries failed refreshes.
- A changed revision invalidates its approval. Worker execution rechecks the
  actor's current project access, source revision/size/location, and destination.
- A destination collision appearing after confirmation pauses again for the
  same approver, never reopening the decision to both people.
- An uncertain remote-upload or version-stack receipt becomes `needs_review`;
  Kit never repeats that external write blindly.
- A file is announced only after Frame byte-size and playable-media verification.

This is not an After Effects render-completion hook. A quiet Dropbox revision
and readable container are useful checks, not proof the artist finished. The
human confirmation is the final readiness boundary. Export locally, then copy
the finished video into Dropbox when practical.

## Rollout checks

1. Apply `20261010143816_frame_upload_approvals.sql` before enabling the flag.
2. Verify Kit's Slack bot can open a group DM with producer and CD and can read
   its history for lost-receipt reconciliation (`mpim:write`, `mpim:history`,
   plus the existing direct-message and chat permissions).
3. Exercise a disposable source and Frame destination: new upload, rename,
   exact-name collision, keep both, skip, replacement of a file, and addition to
   an existing version stack. Confirm the new version is the displayed head and
   the old file/comments remain accessible. Do not test with client deliveries.
4. Exercise a source revision change, simultaneous producer/CD approval,
   lost provider receipt, restart, and a provider outage. Inspect both the
   approval record and the existing transfer/inbox ledgers.
5. Enable the flag on Railway only after those checks, then verify the live
   deployed revision and the existing `dropbox-inbox-sweep` heartbeat.

The initial shared-approval feature was enabled in production on October 10,
2026 at commit `ff0b8f0`. The collision-owner refinement requires its additive
migration and a new bot deployment. Do not describe repository tests as a live
provider contract test; runtime verification is a separate release check.

### Provider contract checks — October 10, 2026

Production migration applied successfully as `20261010143816`; the local filename
matches Supabase's recorded version. The additive table remains unused while the
feature flag is off.

Verified with Kit's existing credentials (no new grants or credential rotation):

- Slack `auth.test` identifies Kit in the expected workspace and includes
  group-DM creation/history permissions. A private conversation containing only
  Kit, the assigned producer and CD was opened; one explicitly labeled test
  message was posted, updated, read back, and removed. No public message sent.
- Frame: three synthetic PNGs uploaded into an isolated restricted test project,
  with exact byte counts and `transcoded` status. A two-file version stack used
  the new file as `head_version`; moving a third file into that stack made it
  the head. Every previous file and a synthetic comment remained readable.
  The application now also verifies the head before reporting replacement done.
- An initial local-upload test lacked Frame's required `x-amz-acl: private`
  header and returned 403. Correcting the test harness resolved it. Kit's
  production path uses remote upload, not this local-upload fixture method.

These provider checks do not alone prove the full live Dropbox-to-Slack-modal
workflow. Production migration, deployed revision, enablement and a monitored
first review remain separate rollout checks.

## Recovery

The additive `frame_upload_collision_owner` migration must be applied before
deploying the collision handlers. It adds a paused `collision` state, private
DM receipts, and service-only atomic pause/resolve functions. It preserves the
existing first-winner decision, upload-post fence, and execution-event outbox.
Pending collisions are not failed uploads and cannot be re-driven until the
original approver resolves them. A newer Dropbox revision supersedes them.

Collision refinement verification (October 10): migration
`20261010153609_frame_upload_collision_owner.sql` was applied, and a rolled-back
production transaction confirmed that the wrong actor and a repeated decision
are rejected, the owner is retained, and Skip adds no execution event. Local
coverage exercises numbered names, ambiguous matches, stale forms, provider
outages, private-DM routing, and actual SQL concurrency/permissions. It does not
claim a real user has completed the new Slack duplicate-resolution form yet.

`frame_upload_approvals` is service-only. Its `notice_dirty` rows drain in
bounded batches from the existing inbox sweep; initial Slack posts reuse the
shared `deliverSlackOnce` receipt ledger. No new cron or second Dropbox cursor
is introduced. Approval waiting is not a failed upload.

For `needs_review`, inspect the named Frame project/file before doing anything.
If Frame accepted the upload, reconcile its exact source revision and receipt
into the transfer ledger. Do not clear `upload_attempted_at` merely to retry.
For ambiguous version writes, verify stack membership before resuming. Do not
delete previous versions. Missing reviewers or Slack permissions are actionable
configuration errors; there is no fallback to posting publicly.

Disabling the flag stops creation of new approval requests and restores the
legacy automatic path for newly detected files. Already approved execution
events remain valid. Prefer fixing the gated path to disabling it: rollback
changes the user-visible safety boundary.

## Related cleanup inventory

The user clarified the cleanup scope as anything pertaining to Nike Sizzle.
Exact matching project records:

- `40975df6-6315-4bbc-9ca6-5ec18ead653f`, code `2566-Nike`, name `Sizzle`,
  Slack channel `C0B5BGT53UP`, historical canvas `F0B7PC3KZ5K`.
- `96a534e2-9a1f-431c-a818-b694de6674b4`, code `4444-Nike`, name `sizzle`,
  Slack channel `C0B5YNA6ZMJ`.

Differently named Nike projects (including Pizza Sizzle, Summer and Socks) and
unrelated Nike reference images remain excluded.

For 2566, read-only checks found one project/brain, one brain revision and nine indexed
project documents. No known Frame, Dropbox or Harvest project IDs are recorded;
no transfer, share, provisioning or Project Control binding rows were found.
Dropbox searches and the exact 2025/2026 folder candidates found no matching
project folder. Slack reports the channel unavailable and canvas access denied.
No production deletions have been executed. Preserve these identifiers until
provider cleanup can be verified; absence of access is not proof of deletion.

For 4444, the project has no recorded Frame, Dropbox or Harvest project IDs.
There are no brain, indexed document, Project Control binding/canvas,
provisioning-step, transfer, time-entry or financial-entry rows. Its recorded
Slack channel also returns `channel_not_found`. Dropbox search returned only
unrelated filename matches; the exact production/2026/4444_Nike_sizzle folder
candidate returned not found. This is not a full provider-absence verification.
Both project records are retained pending external cleanup verification.
