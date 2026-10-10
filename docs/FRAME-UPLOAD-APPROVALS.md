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

- Replace adds a version, retaining the previous file and comments.
- Keep both previews a distinct numbered filename before the final confirmation.
- Skip records the decision and leaves Dropbox untouched.
- Every decision is atomic. Repeated clicks cannot enqueue two uploads.
- A changed revision invalidates its approval. Worker execution rechecks the
  actor's current project access, source revision/size/location, and destination.
- A destination collision appearing after confirmation reopens review.
- An uncertain remote-upload or version-stack receipt becomes `needs_review`;
  Kit never repeats that external write blindly.
- A file is announced only after Frame byte-size and playable-media verification.

This is not an After Effects render-completion hook. A quiet Dropbox revision
and readable container are useful checks, not proof the artist finished. The
human confirmation is the final readiness boundary. Export locally, then copy
the finished video into Dropbox when practical.

## Rollout prerequisites (not yet production-verified)

1. Apply `20261010140828_frame_upload_approvals.sql` before enabling the flag.
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

The feature is staged disabled. Do not describe repository tests as a live
provider contract test. Runtime verification is still required.

## Recovery

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

Nike test scope: project `40975df6-6315-4bbc-9ca6-5ec18ead653f`, code
`2566-Nike`, name `Sizzle`, Slack channel `C0B5BGT53UP`, historical canvas
`F0B7PC3KZ5K`. Other Nike projects and reference images are excluded.

Read-only checks found one project/brain, one brain revision and nine indexed
project documents. No known Frame, Dropbox or Harvest project IDs are recorded;
no transfer, share, provisioning or Project Control binding rows were found.
Dropbox searches and the exact 2025/2026 folder candidates found no matching
project folder. Slack reports the channel unavailable and canvas access denied.
No production deletions have been executed. Preserve these identifiers until
provider cleanup can be verified; absence of access is not proof of deletion.
