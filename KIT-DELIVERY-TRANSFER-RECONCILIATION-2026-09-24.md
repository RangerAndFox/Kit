# Frame.io Delivery-Transfer Reconciliation — the 56 `processing` rows

**Date:** 2026-09-24 · **Table:** `public.frameio_delivery_transfers` · **Scope:** every row with `state = 'processing'` (56 rows)
**Method:** read-only SQL (SELECTs) against production Supabase + code inspection. **No** transfer states were changed, **no** uploads replayed, **no** notifications sent, **no** assets deleted. Project 2639's disabled auto-upload setting and the Fabric (2637) retirement instruction were treated as fixed inputs, not things to act on.

> **Success was NOT inferred from project age or closure.** Each row is classified from ledger facts: its Frame.io asset id, its last known provider status, and whether a *later `ready` transfer exists for the same Dropbox file* (a completed successor). Where a definitive answer needs the live Frame.io asset (existence / byte size / current transcode state), that is called out as **not verifiable here** rather than guessed — the audit environment has **no Frame.io connector**, and the table stores **no size column**.

---

## 1. Reconciling the different count totals

Earlier passes reported several sub-totals; they are all views of the same 56 rows:

| Figure reported | Value | What it actually is |
|---|---|---|
| All `processing` rows | **56** | The full set classified here. |
| "uploaded_awaiting_transcode (53) + other (3)" | 53 + 3 | The **3 "other"** = the 2637 rows whose `last_provider_status` is NULL but which **do** have a `frameio_file_id`. They were *not* "never uploaded"; the earlier label was imprecise. |
| By provider status: created 31 / pending 22 / none 3 | 31/22/3 | `created` = 2625 (3) + 2639 (28). `pending` = 2629 (1) + 2631 (7) + 2633 (3) + 2636 (3) + 2637 (8). `none` = 2637 (3). = 56. |
| "stale > 2 days" | **43** | Excludes the **13 recent** in-flight rows (2631: 7 @ 1.9 d, 2633: 3 @ 1.9 d, 2636: 3 @ 0.7 d). 56 − 13 = 43. |
| "burst in two closed projects" (28 + 11 + 3 + 1) | 43 | Same 43: 2639 = 28, 2637 = 11, 2625 = 3, 2629 = 1. |
| **This reconciliation's classes** | **7 + 28 + 8 + 11 + 2 = 56** | See §2. |

Every figure ties back to the same 56.

---

## 2. Classification of every row

> **Evidence tier applies to ALL rows below.** Every classification is
> **DB-evidenced** — from the Supabase ledger (`frameio_delivery_transfers`,
> `project_settings`, `dropbox_event_inbox`). **None is live-provider-verified:**
> with no Frame.io connector, no row's asset was confirmed to exist / be the
> right size / be finished transcoding on Frame.io. DB evidence is strong for
> "superseded" (a completed sibling) and "disabled" (a project setting), weaker
> for "in-flight" (only the last-known provider status). Any row whose
> resolution depends on live Frame.io is marked **Unresolved**.

Result: **verified-complete 0, superseded (DB) 7, intentionally-disabled (DB) 28, retired-by-instruction 8, unresolved-pending-Frame.io 2, in-flight 11.** All 56 have a `frameio_file_id` in the ledger; none is itself `ready`.

| Class | Evidence tier | Rows | Which | Basis |
|---|---|---:|---|---|
| **Verified complete** | — | 0 | — | No row here is itself `ready`; 7 have a completed sibling (next row). |
| **Superseded** | DB ledger (strong) | 7 | 2625 ×2 (n2,n3); 2631 ×2 (n7,n8); 2637 ×3 (n18–20) | A sibling `ready` transfer for the **same Dropbox file** with `completed`/`deduplicated` status + asset id + share URL. **Per-row evidence in §2.1.** Not live-verified. |
| **Intentionally disabled** | DB (`project_settings`) | 28 | 2639 (n29–56) | `frameio_upload_enabled = FALSE` for 2639. All `created`, no successor. **Will not re-drive by design. Preserve.** |
| **Retired by instruction** | Operator instruction | 8 | 2637 (n21–28) | 2637 = "Microsoft Fabric IQ sizzle". No successful sibling. **⚠ Caveat below — instruction, not yet a data state.** |
| **Provider asset missing** | — | 0\* | — | \*Not determinable here — all carry a `frameio_file_id`, but live existence needs a Frame.io GET. |
| **Unresolved — pending Frame.io** | DB-incomplete → needs live check | 2 | 2625 (n1, 23.8 d); 2629 (n4, 3.0 d) | Past the 24 h window, upload **enabled**, no `ready` sibling. **Formerly "genuinely incomplete" — reclassified UNRESOLVED: the DB cannot distinguish "complete on Frame.io but ledger stale" from "asset missing" from "truly incomplete". Verify live before any action.** |
| **In-flight** | DB (recent) | 11 | 2631 ×5 (n5,n6,n9–11); 2633 ×3 (n12–14); 2636 ×3 (n15–17) | < 2 days old; within normal transcode latency (2636 also has 5 live `retryable` inbox events actively driving them). Expected to self-resolve or age into Unresolved. |

### 2.1 Evidence for each superseded row (DB ledger, not live-verified)

Each processing row has a sibling in `ready` state for the **same `(project, dropbox_file_id)`**, carrying a Frame.io asset id **and** a share URL:

| Project | Processing row (rev) | Ready sibling (rev) | Sibling provider status | Asset + share |
|---|---|---|---|---|
| 2625 | `63a6a4e5` (0165a5f2) | `c7adfeac` (0165a5f2) | completed | yes / yes |
| 2625 | `dbec0b80` (0165a5f2) | `55722e44` (0165a5f2) | completed | yes / yes |
| 2631 | `3abaa21e` (0165c15f) | `10cd487a` (0165c15e) | completed | yes / yes |
| 2631 | `74bc9ec1` (0165c15f) | `7595b5d9` (0165c15d) | completed | yes / yes |
| 2637 | `31eb1ac1` (65a77aa7) | `55176a2f` (65a77aad) | completed | yes / yes |
| 2637 | `be8d8e19` (65a77a8d) | `fd0f0372` (65a77cee) | deduplicated | yes / yes |
| 2637 | `c9ca0d3c` (65a77a83) | `fd0f0372` (65a77cee) | deduplicated | yes / yes |

2631's siblings sit at an *adjacent, slightly-earlier* revision, and `deduplicated` is Frame.io's own "same content already uploaded" terminal — both mean the content reached Frame.io. Confirming the asset still exists there is a live check (§3).

### Per-project detail

- **2639 Jimmy Kimmel — 28 rows — INTENTIONALLY DISABLED.** `frameio_upload_enabled = false`. All `created` (asset registered, upload never advanced), ages 23.6–23.7 d, no successors. This is the expected end-state of disabling the mirror mid-flight. **Do not touch — the disabled setting is authoritative and must be preserved.** (2618 and 2628 Crunchyroll also have upload disabled but have **no** stuck rows.)
- **2637 Microsoft Fabric — 11 rows — RETIRE per instruction.** 3 rows (n18–20, `provider_status` NULL, 22.5 d) are **also superseded** (a later `ready` transfer exists — delivery completed). The other 8 (n21–28, `pending`, 7.9 d) have **no** successful sibling. **⚠ Discrepancy to resolve:** 2637's `project_settings` still shows upload **ENABLED**, and the transfer table has no "retired" state (only `processing`/`ready`/`failed`). So the retirement is a *human instruction that is not yet reflected in any data flag*. Until it is (disable 2637's upload, or introduce/set a retired state), these rows will keep being eligible for any re-drive or a naive stale-sweep. **This is exactly why the stale-`processing` sweep must not be enabled blindly.**
- **2625 Azure — 3 rows.** n2,n3 (same rev `0165a5f2`) are **superseded** (ready sibling). n1 (rev `0165a5ca`, 23.8 d) has **no** ready sibling → **UNRESOLVED (pending Frame.io)** — could be delivered-but-ledger-stale, asset-missing, or truly incomplete; only a live GET decides.
- **2629 Microsoft (MRA) — 1 row (n4, `pending`, 3.0 d).** Upload enabled, no sibling, past the 24 h window → **UNRESOLVED (pending Frame.io)**. 2629 is an active-line project, so do **not** assume closure or completion.
- **2631 / 2633 / 2636 — 13 rows — in-flight.** All `pending`, 0.6–1.9 d, upload enabled. A few (n7,n8 in 2631) already have a `ready` sibling → effectively superseded even while recent; the rest are within normal transcode latency.

---

## 3. Provider-side verification — what was and wasn't possible

| Check requested | Result |
|---|---|
| Provider asset **identity** | Present in the ledger for **all 56** (`frameio_file_id` non-null). **Live existence not verified** — no Frame.io connector in this session. |
| Provider asset **size** | **Not verifiable.** `frameio_delivery_transfers` has **no size column**; comparison needs the source (Dropbox) size and the Frame.io asset size via live GETs. |
| Processing **state** | Only the **last known** `last_provider_status` (`created`/`pending`/NULL) is stored; it is stale. Current Frame.io transcode state needs a live `GET /v4/.../files/{id}`. |

**Still-needed checks (require the app's Frame.io credentials / a Frame.io connector):** for each of the 2 Unresolved rows (2625 n1, 2629 n4) and, if desired, the 8 Fabric rows: `GET` the asset by `frameio_file_id` and confirm existence, `media_type`, `file_size` vs the Dropbox source, and `status`. That single live check resolves each Unresolved row to *verified-complete*, *provider-asset-missing*, or *genuinely-incomplete*.

---

## 4. Recommended disposition (no action taken — proposal only)

1. **Leave 2639 (28) untouched.** Disabled by design; preserve the setting.
2. **Resolve the 2637 Fabric retirement in data, not just instruction** before any sweep — either set `frameio_upload_enabled = false` for 2637 or add/set an explicit retired state — so the 11 rows can't be re-driven. The 3 superseded ones are already delivered.
3. **Live-verify the 2 Unresolved rows** (2625 n1, 2629 n4) against Frame.io before deciding retry vs. fail; 2629 especially, being an active project.
4. **Let the 11 in-flight rows resolve on their own**; re-check in a few days — any still `pending` then join the Unresolved set.
5. **Only after 1–4**, enable the stale-`processing` sweep (LIVE‑3 remediation), and have it **skip projects with `frameio_upload_enabled = false`** and any retired state, so it never re-touches 2639 or mislabels a superseded row.

*All findings are read-only. No transfer states, uploads, notifications, or assets were modified.*
