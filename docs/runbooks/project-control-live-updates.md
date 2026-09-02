# Runbook — Project Control live updates & Frame.io link integrity

Covers the event-driven Sheet→Canvas refresh (Workstream B) and the legacy
Frame.io URL repair. Read `.ai/runtime.md` and `.ai/invariants.md` (esp.
invariant 14) first.

**Ownership (unchanged):** the Master Project List Google Sheet is
authoritative; **Vercel/Inngest** owns Sheet→Canvas sync via the canonical
`runProjectControlSync`. The Apps Script trigger and the Vercel endpoint only
*request a refresh* — they never render a canvas or call Slack. The 10-minute
cron stays enabled as the convergence/recovery path (and is the ONLY path that
catches API/script-originated Sheet changes, which edit triggers cannot see).

## Architecture

```
Human edits or structurally changes Master Project List
  → Apps Script installable On edit / On change triggers  (scripts/apps-script/project-control-sheet-edit.gs)
  → POST /api/webhooks/project-control/sheet-edited   (HMAC-signed, Production only)
  → inngest.send('project-control/sheet.edited', id=<requestId>)
  → projectControlSyncOnEdit  (debounced per workbook)
  → runProjectControlSync()   ← SAME core as the */10 cron
  → edits ONLY each binding's persisted canvas_id
```

## Configuration names

| Where | Name | Notes |
|---|---|---|
| Vercel **Production only** | `PROJECT_CONTROL_WEBHOOK_SECRET` | Shared HMAC secret. Absent ⇒ endpoint fails closed (401). **Never** set in Preview. |
| Vercel (existing) | `PROJECT_CONTROL_SYNC_ENABLED=true` | Gates both cron and event sync. |
| Vercel + Railway | `MASTER_PROJECT_LIST_SPREADSHEET_ID=1qF690PLEK-NrzNUywwkEY-SAzt3pgRc8dG8UzAXeGyo` | **Only supported production control-center workbook.** Both runtimes must use the same value. The retired `RF Production System - Native Google Sheets` workbook must never be configured here. |
| Vercel + Railway | `MASTER_PROJECT_LIST_SHEET_ID=904721650`, `MASTER_PROJECT_LIST_HEADER_ROW=4` | `Projects` tab and its header row. The endpoint rejects requests for any other workbook/tab. |
| Vercel + Railway | `MASTER_PROJECT_LIST_LAYOUT=rf-production-v1` | Enables the normalized Production Control Center schema adapter. |
| Vercel + Railway | `MASTER_PROJECT_LIST_LINKS_SHEET_ID=1721636671`, `MASTER_PROJECT_LIST_LINKS_HEADER_ROW=4` | Normalized `Links` tab. Kit upserts Frame.io/Dropbox URLs here and carries them through Project Control Canvas sync. |
| Vercel (existing) | `GOOGLE_SERVICE_ACCOUNT_JSON` | Also used by the repair utility. |
| Apps Script → Script Properties | `WEBHOOK_URL` | `https://<kit-prod-domain>/api/webhooks/project-control/sheet-edited` |
| Apps Script → Script Properties | `WEBHOOK_SECRET` | Exact same value as `PROJECT_CONTROL_WEBHOOK_SECRET`. |
| Apps Script → Script Properties | `SPREADSHEET_ID`, `SHEET_IDS`, `HEADER_ROW` | Use the Production Control Center values from `project-control-v2.md` (`HEADER_ROW=4`). |

## Production Control Center workbook contract

Kit treats `Projects` as the authoritative project row and translates its new
physical columns into the stable Project Control model. In particular:

- `Project ID` → project number; `Phase` → quick status; `Next Milestone` → next share.
- `Deadline` and `Start Date` are written as native Google Sheets dates.
- `Creative Director`, `Producer`, and the explicit `Client Contact` column are
  updated without touching neighboring columns or validation rules.
- Frame.io and Dropbox URLs live in `Links` (one row per project/link type).
  Creation is retry-safe, existing human link labels are preserved, and changing
  a Project ID moves every matching link row to the new ID.
- The old `RF Production System - Native Google Sheets` workbook is retired and
  must not have Kit triggers or runtime configuration attached. Historical data
  may remain in that workbook, but it is not an input to provisioning, sync, or
  Slack Canvas generation.

Endpoint (POST only): `/api/webhooks/project-control/sheet-edited`
Inngest event: `project-control/sheet.edited`. Replay dedupe is enforced by
**function-level idempotency** on `event.data.request_id` (the Apps Script
`requestId`) — Inngest's event-level `id` does not dedupe a debounced function;
`debounce` (keyed on `spreadsheet_id`) separately coalesces distinct bursts.

## Apps Script setup

1. Open the Master Project List → **Extensions → Apps Script**.
2. Create a script file and paste `scripts/apps-script/project-control-sheet-edit.gs`.
3. **Project Settings → Script Properties** → add `WEBHOOK_URL`, `WEBHOOK_SECRET`,
   `SPREADSHEET_ID`, `SHEET_IDS`, `HEADER_ROW`. The production values are:
   - `SPREADSHEET_ID=1qF690PLEK-NrzNUywwkEY-SAzt3pgRc8dG8UzAXeGyo`
   - `SHEET_IDS=904721650,1377810846,1186252714,958596238,1721636671,454974547,328162234`
   - `HEADER_ROW=4`
4. **Triggers** (clock icon) → **Add Trigger**:
   - Function: `onMasterProjectListEdit`
   - Event source: **From spreadsheet**
   - Event type: **On edit**
   This creates the **installable** trigger (required — the restricted simple
   `onEdit` cannot make external requests). Do **not** rename the function to
   `onEdit`.
5. Add a second installable trigger:
   - Function: `onMasterProjectListChange`
   - Event source: **From spreadsheet**
   - Event type: **On change**
   This covers structural changes (insert/delete/move/sort rows) that Google's
   edit event does not report.
6. Authorize the script when prompted (it needs external-request + this-workbook
   scopes only; it never reads credentials or cell contents).

## Producer row controls

The Apps Script also adds two lightweight controls to every authoritative
source tab: `Projects`, `Project Specs`, `Daily Assignments`, `Links`,
`Workback`, `Deliverables`, and `Status Log`.

### Filter a tab to one project

1. In the frozen control row, type or select a Project ID in **B3**.
2. Kit immediately hides rows belonging to other projects on that tab.
3. Clear **B3**, or choose **Kit → Clear project filter**, to show every row
   again.

The filter changes only the Sheet view. It is not project data and does not
request a Slack Canvas refresh.

### Add a row without scrolling

1. Open the source tab that should receive the new row.
2. Choose **Kit → Add row to this tab**.
3. Complete the tab-specific form. Required fields are marked with `*`, Project
   IDs are selected from `Projects`, and existing Sheet validation choices are
   reused wherever possible.
4. Choose **Add row**.

Kit validates the entry, writes it into the first open prepared row, preserves
that row's formatting and data validation, focuses the tab on the affected
project, and explicitly requests the normal Sheet→Canvas refresh. It never
appends a record below the prepared table. `Projects` and `Project Specs` allow
only one row per Project ID; activity tabs allow multiple rows.

For a brand-new project that also needs Slack, Dropbox, Frame.io, Harvest, and
Canvas provisioning, use Kit's Slack project provisioner. The `Projects` Add
Row form deliberately creates only the authoritative Sheet record.

## Rollout (controlled — do NOT execute without authorization)

1. **Deploy the app** with the event path inert: `PROJECT_CONTROL_WEBHOOK_SECRET`
   absent everywhere ⇒ the endpoint returns 401 to everything. The `/10` cron is
   unaffected.
2. Add `PROJECT_CONTROL_WEBHOOK_SECRET` to **Vercel Production only**; redeploy.
   (Registration order: redeploy so `/api/inngest` re-syncs the new
   `projectControlSyncOnEdit` function to Inngest before any events arrive.)
3. Add the **same** secret to Apps Script Script Properties.
4. Install the onEdit trigger (step 4 above).
5. Make **one** controlled edit on a disposable project row.
6. Verify:
   - one authenticated `POST /api/webhooks/project-control/sheet-edited` → 202;
   - one `project-control/sheet.edited` Inngest event;
   - the run edits the **same** binding + canvas_id (no new binding/canvas);
   - the Canvas reflects the final Sheet value within seconds;
   - a later cron tick reports **no material change** (unchanged hash).

## Rollback

- Disable/remove the Apps Script **trigger** (Triggers → delete), and/or remove
  `PROJECT_CONTROL_WEBHOOK_SECRET` from Vercel Production (endpoint then fails
  closed). The `/10` cron continues to converge the Canvas. No data migration is
  involved; nothing else changes.

## Legacy Frame.io URL repair (dry-run first)

Fixes existing rows whose Frame.io column holds the exact legacy shape
`https://app.frame.io/projects/{id}` → `https://next.frame.io/project/{id}`
(id preserved). It inspects ONLY the Frame.io column, never rewrites other
Frame.io links or non-matching values, and is idempotent. Requires the Google
env above. After an authorized repair, normal Sheet→Canvas sync propagates the
corrected URL to the same canvases (no second Canvas repair).

```bash
# 1) DRY RUN — reports Row N: <old> -> <new>, writes nothing:
npx tsx scripts/project-control/repair-frameio-urls.ts

# 2) Only after reviewing the dry-run report AND obtaining authorization:
npx tsx scripts/project-control/repair-frameio-urls.ts --apply
```

Expected dry-run report shape:

```
[repair] Frame.io URL repair — mode: DRY RUN (no writes)
[repair] workbook=<id> sheet=<gid> column=Frame.io
[repair] N legacy URL(s) would be rewritten:
  Row 12: https://app.frame.io/projects/abc-123  ->  https://next.frame.io/project/abc-123
  ...
[repair] DRY RUN complete — no cells written. Re-run with --apply to write (requires authorization).
```

If the workbook env is unset the utility **refuses** (exit 1) and writes
nothing.
