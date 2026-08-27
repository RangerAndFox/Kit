# Project Control v2 — rollout

The Google Sheet is the only editable source. Slack’s Overview, Reference, and Schedule canvases are generated, read-only projections.

## Production workbook

- Workbook: `1qF690PLEK-NrzNUywwkEY-SAzt3pgRc8dG8UzAXeGyo`
- Projects: `904721650`
- Project Specs: `1377810846`
- Workback: `1186252714`
- Daily Assignments: `958596238`
- Links: `1721636671`
- Deliverables: `454974547`
- Status Log: `328162234`
- Header row: `4`

Set the matching `MASTER_PROJECT_LIST_*` variables shown in `.env.example` in both Vercel and Railway. Enable `PROJECT_CONTROL_CREATION_ENABLED=true` and `PROJECT_CONTROL_SYNC_ENABLED=true` only after the migration and Apps Script are installed.

## Database

Apply `20260827230925_project_control_v2.sql`. It adds:

- `project_control_canvases`: one durable binding for each project/view pair.
- `project_share_events`: an idempotent Dropbox file-revision ledger for producer-confirmed schedule progression.

Both tables have RLS enabled with no client policies; Kit’s service-role processes are the only callers.

## Slack templates

`SLACK_PROJECT_CANVAS_TEMPLATE_IDS` must contain exactly the approved Overview, Reference, and Schedule template file IDs. The default is:

`F0BT5QT3C4E,F0BSSC7NZKR,F0BT3LH43U5`

Kit excludes the Overview template from generic cloning and creates it through the managed Project Control path. It clones Reference and Schedule, records their IDs, sets all three canvases to read-only, then replaces their content from the normalized workbook on every sync.

## Apps Script

Replace the workbook Apps Script with `scripts/apps-script/project-control-sheet-edit.gs`. Set:

- `SPREADSHEET_ID=1qF690PLEK-NrzNUywwkEY-SAzt3pgRc8dG8UzAXeGyo`
- `SHEET_IDS=904721650,1377810846,1186252714,958596238,1721636671,454974547,328162234`
- `HEADER_ROW=4`
- existing production webhook URL and shared secret

Human edits on any authoritative source tab trigger the debounced live refresh. Kit API writes call the same signed endpoint immediately; the existing ten-minute sync cron remains the recovery path.

## Provisioning behavior

The new-project modal asks for start date, deadline, workback style, and milestone count. Kit:

1. Creates the Supabase project and selected external services, including a blank Boords shell when available.
2. Writes the bound Projects row and normalized Specs, Workback, Links, Deliverables, and Status Log rows.
3. Generates milestone dates over business days inside the project window. The schedule begins as Draft.
4. Creates exactly three read-only channel canvases and stores their durable identities.

## Share progression

After Dropbox uploads a new `01_Client Progress` or `02_Delivery` file to Frame.io, Kit:

1. Saves the latest share label, URL, date, and matched milestone in Projects.
2. Deduplicates the event by Dropbox `file id + rev`.
3. DMs the producer with an Advance / Keep Current card when the filename confidently matches a workback task.
4. On approval, marks earlier tasks Complete, the shared task Client Review, and the next task In Progress; updates Next Milestone; and appends Status Log.

An uncertain filename never advances the schedule automatically. Final Delivery also remains producer-confirmed.

## Smoke test

Create a disposable project with a two-week date range and five milestones. Confirm:

- one row appears in each expected source table;
- Overview, Reference, and Schedule are the only project canvas tabs and are read-only;
- editing a spec and a due date refreshes the appropriate canvas;
- uploading a uniquely named milestone file updates Latest Share once;
- accepting the DM advances the correct three schedule states once;
- replaying the same Dropbox revision creates no second prompt or state transition.
