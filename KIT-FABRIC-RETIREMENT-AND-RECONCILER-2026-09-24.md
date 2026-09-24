# Fabric queue retirement + stale-transfer reconciler — design & inventory

**Status:** DRAFT on the review branch. **Nothing executed, no production data mutated, nothing deployed.** No migration applied. No project's future uploads disabled. This documents the reactivation inventory, an audited retirement mechanism, and a disabled reconciler, with the exact verification steps to run under review.

---

## 1. Reactivation inventory — what could re-drive the historical rows

A `processing` transfer can only be re-driven two ways: (a) a durable **inbox event** for it is claimed and processed, or (b) a future **stale-processing sweep** reads the row directly. The claim RPC (`claim_dropbox_events`, verified from the baseline) only claims events with `status in ('pending','retryable') and next_attempt_at <= now()`, plus lease-expired `processing`; `complete` and `dead_letter` are never auto-claimed.

Inbox (`dropbox_event_inbox`) state for the relevant projects (live read):

| Project | complete | dead_letter | retryable | Reactivation risk |
|---|---:|---:|---:|---|
| **2637 (Fabric)** | **76** | 0 | 0 | **None via inbox** — every event is terminal `complete`. The 11 stuck transfers are pure orphans (event finished, transfer never advanced). Only a future sweep could touch them. |
| 2639 (Jimmy Kimmel) | 28 | 34 | 0 | Uploads **disabled**; dead_letter does not auto-replay. None. |
| 2631 | 33 | 15 | 0 | dead_letter (manual requeue only). |
| 2633 | 12 | 3 | 0 | dead_letter (manual requeue only). |
| 2636 | 4 | 0 | **5** | **Live** — 5 `retryable` events actively driving the 3 recent in-flight rows (expected). |
| 2625 | 12 | 0 | 0 | None via inbox. |
| 2629 | 8 | 0 | 0 | None via inbox. |

**Conclusion for the Fabric set:** the 8 non-delivered 2637 rows (n21–28) have **no live inbox/retry record** that can reactivate them today; the only future risk is a stale sweep. Retiring the transfer rows (so a sweep skips them) is therefore sufficient — the mechanism below also neutralizes inbox events generally, for completeness and for any future set (e.g. 2631/2633 dead-letters) that does carry replayable records.

*Other reactivation surfaces considered:* `seen_dropbox_files` (dedupe ledger, does not re-drive), the Dropbox cursor (advances forward, does not replay individual files), and `project_share_events` (share notifications, not uploads). None re-drives a transfer on its own.

---

## 2. Retirement mechanism (migration `20260924160000_frameio_transfer_retirement.sql` + `src/lib/delivery/transfer-retirement.ts`)

**Guarantees (all enforced in code and/or schema):**
- **Never marks a row delivered.** A CHECK makes `retired_at IS NOT NULL AND state = 'ready'` unrepresentable; the library refuses to retire a `ready` row.
- **Prevents replay.** `retired_at` is added to `dropbox_event_inbox` and the `claim_dropbox_events` candidate filter gains `and retired_at is null`, so a retired item's event is never claimed — even a lease-expired one.
- **Preserves history.** Rows are not deleted; an append-only `frameio_transfer_retirements` audit table records `{transfer_id, prior_state, reason, retired_by, evidence, retired_at}`.
- **Idempotent + dry-run by default.** `retireTransfers(..., { dryRun })` defaults to a no-write plan; re-retiring an already-retired row does nothing.
- **Per-row, not per-project.** Retirement marks individual transfers/events; it does **not** touch `project_settings`, so **future uploads for 2637 are not disabled** (that would need separate approval).

**What it targets for the Fabric set:** the **8** non-delivered 2637 rows (n21–28). The other **3** 2637 rows (n18–20) are *superseded* — their sibling already reached `ready`/`completed`/`deduplicated` — so they are candidates for the reconciler's `reconcile_ready` (ledger correction), not retirement. No inbox neutralization is needed for 2637 (all events `complete`), but the mechanism performs it where applicable.

**Decision logic is pure and tested** (`classifyForRetirement`): ready→refused, retired→no-op, processing/failed→eligible. IO is a thin injected-client wrapper (tests in `transfer-retirement.test.ts`).

---

## 3. Stale-transfer reconciler (`src/lib/delivery/stale-transfer-reconciler.ts`) — DISABLED

Gated behind `STALE_TRANSFER_RECONCILER_ENABLED === 'true'`, `dryRun` defaults TRUE, and it is **not registered as any cron or command**. Rules (pure + tested in `stale-transfer-reconciler.test.ts`):

- **Skips** rows that are retired (`retired_at`), belong to an upload-disabled project (`frameio_upload_enabled = false`), or aren't `processing` — **before** any provider call.
- **Verifies live provider state first** via a **required injected** `verifyProvider` (no default that could guess). It never infers completion from age or closure.
- **Decides conservatively:** verified complete+shared → `reconcile_ready` (ledger correction only); verified absent → `mark_failed` (not delivered); anything unknown/partial → `leave_unresolved` (no change).
- **Never re-uploads and never notifies producers.** For unresolved/historical rows it does nothing. The most it ever does is a ledger state change with no side effects.

The real `verifyProvider` (a read-only Frame.io GET) is intentionally **not implemented here** — the audit environment has no Frame.io connector.

---

## 4. Access gaps (still blocking a live decision)

| Gap | Impact | Needed |
|---|---|---|
| **No Frame.io connector / credentials in this session** | Can't verify asset existence, size, or transcode state for any row → the 2 Unresolved rows and the 3 superseded 2637 rows can't be finalized; `verifyProvider` can't be implemented/run here. | A Frame.io API check (the app's existing IMS token) or a Frame.io MCP connector. |
| **Railway `/health` + deployed SHA** (proxy-blocked) | Can't confirm the worker is live right now. | Check from inside the network (see heartbeat doc). |
| **Apps Script (Sheet)** | Sheet-edit webhook sender unverified. | Open Extensions → Apps Script. |

---

## 5. Exact verification steps (run under review, before any execution)

**A. Confirm the retirement target set (read-only):**
```sql
select id, dropbox_rev, last_provider_status, created_at
from public.frameio_delivery_transfers t
where t.state='processing' and t.retired_at is null
  and t.project_id = (select id from public.projects where project_code like '2637%')
  and not exists (  -- exclude superseded (delivered via sibling)
    select 1 from public.frameio_delivery_transfers r
    where r.project_id=t.project_id and r.dropbox_file_id=t.dropbox_file_id
      and r.state='ready' and r.id<>t.id)
order by created_at;   -- expect the 8 non-delivered Fabric rows
```

**B. Provider verification (per Unresolved / superseded row)** — with Frame.io access, `GET` each asset by `frameio_file_id` and record existence, `media_type`, `file_size` vs the Dropbox source size, and transcode `status`. This is what `verifyProvider` must implement.

**C. Dry-run the retirement** (no writes): call `retireTransfers(client, { transferIds: [...8 ids...], reason: 'Fabric 2637 historical queue retirement', retiredBy: '<operator>' })` (dryRun defaults true) and confirm the plan: 8 eligible, 0 refused, 0 already-retired.

**D. Apply (only on explicit approval):** apply migration `20260924160000` first, then run the retirement with `dryRun: false`. Verify:
```sql
select count(*) from public.frameio_transfer_retirements;                       -- 8 audit rows
select count(*) from public.frameio_delivery_transfers where retired_at is not null; -- 8
select count(*) from public.frameio_delivery_transfers where retired_at is not null and state='ready'; -- 0 (never delivered)
```

**E. Reconciler** remains disabled. Enabling it is a separate, later decision requiring a real `verifyProvider` and `STALE_TRANSFER_RECONCILER_ENABLED=true`, run in dry-run first.

---

*All of the above is on the review branch only. No production data was mutated; no migration was applied; no uploads, notifications, or state changes were performed; 2639's disabled setting and 2637's future uploads are untouched.*
