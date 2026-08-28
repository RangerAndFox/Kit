/**
 * Kit — Master Project List → Project Control live-update trigger.
 *
 * Google Apps Script *installable* On edit AND On change triggers (NOT simple
 * triggers, which cannot make external requests). On a human cell edit inside
 * an authoritative source tab, or a structural workbook change such as
 * inserting/deleting/sorting rows, it POSTs a tiny HMAC-signed notification to Kit's
 * production Vercel endpoint, which asks Inngest to run the canonical Project
 * Control sync. This script NEVER renders a canvas, calls Slack, or reads Sheet
 * cell contents — it only says "the workbook changed, please refresh".
 *
 * IMPORTANT: Apps Script edit triggers fire only for INTERACTIVE (human) edits.
 * They do NOT fire for changes made by the Sheets API, other Apps Scripts, or
 * imports. Those are exactly why Kit keeps the 10-minute cron as the
 * convergence/recovery mechanism — do not remove it.
 *
 * ── Setup (see docs/runbooks/project-control-live-updates.md) ─────────────────
 * 1. Extensions → Apps Script on the Master Project List workbook.
 * 2. Paste this file. Set Script Properties (Project Settings → Script
 *    Properties):
 *      WEBHOOK_URL    = https://<kit-prod-domain>/api/webhooks/project-control/sheet-edited
 *      WEBHOOK_SECRET = <same value as Vercel PROJECT_CONTROL_WEBHOOK_SECRET>
 *      SPREADSHEET_ID = <Master Project List spreadsheet id>
 *      SHEET_IDS      = <comma-separated gids of all authoritative source tabs;
 *                        put the Projects tab first because it is the signed workbook identity>
 *      SHEET_ID       = <optional explicit Projects-tab gid; defaults to first SHEET_IDS value>
 *      HEADER_ROW     = 3   (optional; edits on/above this row are ignored)
 * 3. Triggers (clock icon) → Add Trigger:
 *      function: onMasterProjectListEdit
 *      event source: From spreadsheet
 *      event type: On edit
 * 4. Add a second trigger:
 *      function: onMasterProjectListChange
 *      event source: From spreadsheet
 *      event type: On change
 *    (This creates the INSTALLABLE trigger. Do not rename the function to
 *    `onEdit`, which would register the restricted simple trigger instead.)
 */

function onMasterProjectListEdit(e) {
  try {
    if (!e || !e.range) return; // not an edit event

    var props = PropertiesService.getScriptProperties();
    var webhookUrl = props.getProperty('WEBHOOK_URL');
    var secret = props.getProperty('WEBHOOK_SECRET');
    var spreadsheetId = props.getProperty('SPREADSHEET_ID');
    var sheetIds = (props.getProperty('SHEET_IDS') || props.getProperty('SHEET_ID') || '').split(',').map(function (id) { return String(id).trim(); }).filter(Boolean);
    var primarySheetId = props.getProperty('SHEET_ID') || sheetIds[0];
    var headerRow = parseInt(props.getProperty('HEADER_ROW') || '3', 10);

    // Fail visibly in the logs, never modify the sheet, never send half-configured.
    if (!webhookUrl || !secret || !spreadsheetId || sheetIds.length === 0) {
      Logger.log('[kit] skipped: missing Script Properties (WEBHOOK_URL/WEBHOOK_SECRET/SPREADSHEET_ID/SHEET_IDS)');
      return;
    }

    // Ignore edits outside the configured workbook / control tabs. The payload
    // always carries the primary Projects tab id because Kit authenticates that
    // stable workbook identity, then refreshes the entire workbook projection.
    var editedSpreadsheetId = e.source && e.source.getId ? e.source.getId() : null;
    if (editedSpreadsheetId && editedSpreadsheetId !== spreadsheetId) return;

    var sheet = e.range.getSheet();
    var editedSheetId = String(sheet.getSheetId());
    if (sheetIds.indexOf(editedSheetId) === -1) return;

    // Ignore header rows and above (labels, not project data).
    if (e.range.getRow() <= headerRow) return;

    requestKitProjectControlRefresh_(webhookUrl, secret, spreadsheetId, primarySheetId, 'edit');
  } catch (err) {
    Logger.log('[kit] onMasterProjectListEdit error: %s', err && err.message ? err.message : err);
  }
}

/**
 * Install this as a separate "On change" trigger. Google does not emit an edit
 * event when a producer inserts/deletes/moves/sorts rows, yet those operations
 * can change the authoritative projection. Change events do not reliably carry
 * a range, so this intentionally requests one safe workbook-level refresh.
 */
function onMasterProjectListChange(e) {
  try {
    if (!e || !e.source) return;
    var props = PropertiesService.getScriptProperties();
    var webhookUrl = props.getProperty('WEBHOOK_URL');
    var secret = props.getProperty('WEBHOOK_SECRET');
    var spreadsheetId = props.getProperty('SPREADSHEET_ID');
    var sheetIds = (props.getProperty('SHEET_IDS') || props.getProperty('SHEET_ID') || '').split(',').map(function (id) { return String(id).trim(); }).filter(Boolean);
    var primarySheetId = props.getProperty('SHEET_ID') || sheetIds[0];
    if (!webhookUrl || !secret || !spreadsheetId || sheetIds.length === 0) {
      Logger.log('[kit] skipped change: missing Script Properties');
      return;
    }
    if (e.source.getId && e.source.getId() !== spreadsheetId) return;
    requestKitProjectControlRefresh_(webhookUrl, secret, spreadsheetId, primarySheetId, e.changeType || 'change');
  } catch (err) {
    Logger.log('[kit] onMasterProjectListChange error: %s', err && err.message ? err.message : err);
  }
}

function requestKitProjectControlRefresh_(webhookUrl, secret, spreadsheetId, primarySheetId, reason) {
  // Minimal metadata only — NO sheet contents, NO credentials.
  var payload = {
    requestId: Utilities.getUuid(),
    timestamp: Date.now(),
    spreadsheetId: spreadsheetId,
    sheetId: Number(primarySheetId)
  };
  var body = JSON.stringify(payload);
  var sigBytes = Utilities.computeHmacSha256Signature(body, secret);
  var signature = 'sha256=' + sigBytes.map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
  var res = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: body,
    headers: { 'X-Kit-Signature': signature },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 200 && code < 300) {
    Logger.log('[kit] refresh requested (%s): %s (%s)', reason, code, payload.requestId);
  } else {
    Logger.log('[kit] refresh request FAILED (%s): HTTP %s body=%s', reason, code, res.getContentText());
  }
}
