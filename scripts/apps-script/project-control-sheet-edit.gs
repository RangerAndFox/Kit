/**
 * Kit — Master Project List → Project Control live-update trigger.
 *
 * A Google Apps Script *installable* onEdit trigger (NOT the simple onEdit,
 * which cannot make external requests). On a human edit inside the configured
 * spreadsheet + target sheet, it POSTs a tiny HMAC-signed notification to Kit's
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
 *      SHEET_ID       = <numeric gid of the target sheet/tab>
 *      HEADER_ROW     = 3   (optional; edits on/above this row are ignored)
 * 3. Triggers (clock icon) → Add Trigger:
 *      function: onMasterProjectListEdit
 *      event source: From spreadsheet
 *      event type: On edit
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
    var sheetId = props.getProperty('SHEET_ID');
    var headerRow = parseInt(props.getProperty('HEADER_ROW') || '3', 10);

    // Fail visibly in the logs, never modify the sheet, never send half-configured.
    if (!webhookUrl || !secret || !spreadsheetId || !sheetId) {
      Logger.log('[kit] skipped: missing Script Properties (WEBHOOK_URL/WEBHOOK_SECRET/SPREADSHEET_ID/SHEET_ID)');
      return;
    }

    // Ignore edits outside the configured workbook / target sheet.
    var editedSpreadsheetId = e.source && e.source.getId ? e.source.getId() : null;
    if (editedSpreadsheetId && editedSpreadsheetId !== spreadsheetId) return;

    var sheet = e.range.getSheet();
    if (String(sheet.getSheetId()) !== String(sheetId)) return;

    // Ignore header rows and above (labels, not project data).
    if (e.range.getRow() <= headerRow) return;

    // Minimal metadata only — NO sheet contents, NO credentials.
    var payload = {
      requestId: Utilities.getUuid(),
      timestamp: Date.now(),
      spreadsheetId: spreadsheetId,
      sheetId: Number(sheetId)
    };
    var body = JSON.stringify(payload);

    // Sign the EXACT body we send with HMAC-SHA256 (hex).
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
      Logger.log('[kit] refresh requested: %s (%s)', code, payload.requestId);
    } else {
      // Visible failure — do NOT retry-loop and do NOT touch the sheet.
      Logger.log('[kit] refresh request FAILED: HTTP %s body=%s', code, res.getContentText());
    }
  } catch (err) {
    Logger.log('[kit] onMasterProjectListEdit error: %s', err && err.message ? err.message : err);
  }
}
