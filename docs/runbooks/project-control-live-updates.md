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
Human edits Master Project List row
  → Apps Script installable onEdit trigger  (scripts/apps-script/project-control-sheet-edit.gs)
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
| Vercel (existing) | `MASTER_PROJECT_LIST_SPREADSHEET_ID`, `MASTER_PROJECT_LIST_SHEET_ID`, `MASTER_PROJECT_LIST_HEADER_ROW` | Workbook config; the endpoint rejects any request whose workbook/sheet doesn't match. |
| Vercel (existing) | `GOOGLE_SERVICE_ACCOUNT_JSON` | Also used by the repair utility. |
| Apps Script → Script Properties | `WEBHOOK_URL` | `https://<kit-prod-domain>/api/webhooks/project-control/sheet-edited` |
| Apps Script → Script Properties | `WEBHOOK_SECRET` | Exact same value as `PROJECT_CONTROL_WEBHOOK_SECRET`. |
| Apps Script → Script Properties | `SPREADSHEET_ID`, `SHEET_ID`, `HEADER_ROW` | `SHEET_ID` is the numeric tab gid; `HEADER_ROW` defaults to 3. |

Endpoint (POST only): `/api/webhooks/project-control/sheet-edited`
Inngest event: `project-control/sheet.edited` (dedupe id = the Apps Script `requestId`).

## Apps Script setup

1. Open the Master Project List → **Extensions → Apps Script**.
2. Create a script file and paste `scripts/apps-script/project-control-sheet-edit.gs`.
3. **Project Settings → Script Properties** → add `WEBHOOK_URL`, `WEBHOOK_SECRET`,
   `SPREADSHEET_ID`, `SHEET_ID`, `HEADER_ROW`.
4. **Triggers** (clock icon) → **Add Trigger**:
   - Function: `onMasterProjectListEdit`
   - Event source: **From spreadsheet**
   - Event type: **On edit**
   This creates the **installable** trigger (required — the restricted simple
   `onEdit` cannot make external requests). Do **not** rename the function to
   `onEdit`.
5. Authorize the script when prompted (it needs external-request + this-workbook
   scopes only; it never reads credentials or cell contents).

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
