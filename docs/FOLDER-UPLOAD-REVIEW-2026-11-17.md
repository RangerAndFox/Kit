# Folder upload review

Railway keeps the existing outgoing cursor, stability checks, execution inbox,
per-file approval/rename ledger, Frame readiness verification and collision flow.
The UI now groups the first outgoing child directory (for example `111726`) and
its nested Video/Accessibility folders into one private producer/CD card.

The card links Dropbox and has **UPLOAD TO FRAME / CANCEL UPLOAD**. Upload opens
an editable client-facing prefix and an exact filename/destination confirmation
with Go back. Delivery adds actual extension/format and today's Pacific date;
Client Progress uses the editable phase prefix and date. Extensions and folder
structure are preserved; same-format names within one destination are numbered.

The database manifest contains exact per-file approval IDs and versions. Both
reviewers may open forms, but one atomic project-locked decision wins. New files
or revisions invalidate a stale form and do not inherit consent. Cancel skips
only pending files, not already approved/complete ones. Conditional same-name
Frame conflicts still ask only the original approver to Replace (add version),
Keep both (numbered name) or Skip. No browser/Slack form directly transfers media.

One folder receipt plus a sender lease coalesces retries and later files into
edits of the same card. Unknown Slack outcomes use the existing durable-delivery
reconciler, never a fresh key. Old individual cards are edited in place without
deletion; stale buttons/forms cannot approve a file independently. Completed
uploads/ambiguous POST receipts remain untouched. No migration auto-approves work.

## Rollout

1. Run migration/SQL behavior tests, Bolt tests, typechecks, lint and build gates.
2. Apply `20261117153133_folder_upload_reviews.sql` before the new Railway code.
   The additive schema is compatible with the old runtime during deployment.
3. Merge only after all required release checks pass; verify deployed SHA and
   Slack connectivity. The new publisher discovers existing pending requests
   so the normal inbox sweep adopts them into folder cards without upload.
4. Verify a pending real folder has one receipt and no automated approvals.

`FRAMEIO_FOLDER_UPLOADS_ENABLED=false` is the scoped rollback to legacy UI if
needed; it does not undo accepted file approvals or repeat uploads. Retain the
additive migration and all receipts. No new cron, Inngest function or HTTP route.

The release also patches gate-detected dependencies without bypassing the gates:
Next/eslint-config-next 16.4.3 → 16.4.6, systeminformation → 5.33.23, and Bolt's
follow-redirects 1.16.1 → 1.16.3. Remaining moderate advisories are not represented
as a clean security audit; production high/critical gates still apply.
