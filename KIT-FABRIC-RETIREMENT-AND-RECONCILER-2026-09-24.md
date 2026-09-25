# Historical Fabric retirement and read-only reconciliation

Corrected implementation, September 24, 2026. This document supersedes the earlier non-atomic draft.

## Scope

The owner authorized retiring historical Fabric queue work. Preserve future uploads for 2637 and preserve the existing disabled-upload setting for 2639. No deletion of source/media files, re-uploads, share generation, notifications, or project-wide disablement is part of retirement.

All 11 historical Fabric processing rows remain unverified as delivered. The three previously called “superseded” must **not** be marked ready based on another revision's ledger record. A cleanup manifest must identify the exact approved transfer IDs and full revisions, not a broad project query executed later.

## Atomic operator-only retirement

Migration 20260924160000 adds:
- Nullable retirement markers on transfer and inbox records.
- An immutable audit snapshot with no cascading foreign key; service_role has SELECT only.
- Service-only retire_frameio_transfer RPC: exact transfer/project/file/revision/version and sorted event-ID manifest, row locks, and refusal of every processing claim (including expired leases).
- One transaction for audit, transfer marker and exact-revision inbox markers. Any failure rolls everything back.
- A retry returns already_retired only after checking the audit and all matched inbox markers.
- Claim filtering excludes retired events; the live worker checks exact retired revisions before any upload/share/notification. A database trigger prevents stale updates to retired transfers.
- A CHECK rejects retirement of ready records. Retirement retains the prior state; it is never evidence of successful delivery.

The TypeScript adapter in src/lib/delivery/transfer-retirement.ts calls this RPC and defaults to dry-run. It is not exposed through a web route, command or cron. Each transfer is atomic; a multi-transfer batch can safely resume after a partial batch failure.

The actual migration is exercised by scripts/retirement-database.test.ts with production-like default service-role grants. Tests cover final-write failure rollback, retry, exact revision isolation, active/expired worker fencing, claim behavior, anonymous denial, audit UPDATE/DELETE/TRUNCATE denial and audit retention after source deletion.

## Operator procedure

1. Refresh a read-only inventory, freeze exact historical targets, full revisions, updated_at and matched frameio_delivery event IDs.
2. Invoke retire_frameio_transfer for each target with p_dry_run=true. Inspect every receipt. A changed manifest/version or processing worker blocks the operation.
3. With the owner's authorization, invoke the same manifest with p_dry_run=false. The RPC rechecks everything under locks.
4. Verify audit count, marker count, exact inbox markers, zero retired-ready rows, and unchanged project settings/future revisions. Retain receipts.
5. If a row conflicts, stop that row; do not replace its expected version or broaden its scope automatically.

## Reconciler safety

src/lib/delivery/stale-transfer-reconciler.ts is a read-only evidence collector with no write client. It is not registered to any cron.
- Disabled by default; an enabled run is still read-only.
- dryRun=false throws before reads.
- Skips retired, upload-disabled and non-processing snapshots.
- Provider outages, 404s, unknown size or mismatched identity remain unresolved.
- Only positive exact identity/size/completion/share evidence yields verified_ready_candidate. Nothing writes ready or failed.
- No historical messages or uploads are emitted.

A production source-revision/provider verifier and any future correction workflow require a separate reviewed implementation. This release does not pretend the two unresolved 2625/2629 assets, or the later 2631 revisions, have been repaired.
