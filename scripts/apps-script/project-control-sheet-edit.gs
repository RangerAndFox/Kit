/**
 * Kit — Master Project List → Project Control live-update trigger.
 *
 * Google Apps Script *installable* On edit AND On change triggers (NOT simple
 * triggers, which cannot make external requests). On a human cell edit inside
 * an authoritative source tab, or a structural workbook change such as
 * inserting/deleting/sorting rows, it POSTs a tiny HMAC-signed notification to Kit's
 * production Vercel endpoint, which asks Inngest to run the canonical Project
 * Control sync. It also owns producer-only sheet utilities: the project-ID row
 * filter and the validated Add Row sidebar. It never renders a canvas or calls
 * Slack directly.
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
 *      HEADER_ROW     = 4   (optional; edits on/above this row are ignored,
 *                            except the local project filter in B3)
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

    var sheet = e.range.getSheet();
    // Row 3 is a producer-only view control, not authoritative project data.
    // Handle it locally and do not request a Slack Canvas refresh.
    if (handleKitProjectFilterEdit_(e, sheet)) return;

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

    var editedSheetId = String(sheet.getSheetId());
    if (sheetIds.indexOf(editedSheetId) === -1) return;

    // Ignore header rows and above (labels, not project data).
    if (e.range.getRow() <= headerRow) return;

    requestKitProjectControlRefresh_(webhookUrl, secret, spreadsheetId, primarySheetId, 'edit');
  } catch (err) {
    Logger.log('[kit] onMasterProjectListEdit error: %s', err && err.message ? err.message : err);
  }
}

var KIT_SOURCE_SHEET_CONFIG_ = {
  'Projects': {
    required: ['Project ID', 'Client', 'Project Name'],
    uniqueProject: true,
    defaults: { 'Project Type': 'Client', 'Lifecycle': 'Active', 'Schedule Status': 'Draft' },
    note: 'For full Slack, Dropbox, Frame.io, Harvest, and canvas provisioning, create the project through Kit in Slack. This form adds the source row only.'
  },
  'Project Specs': {
    required: ['Project ID'],
    uniqueProject: true,
    defaults: { 'Specs Status': 'Needs Review' }
  },
  'Daily Assignments': {
    required: ['Project ID', 'Date', 'Person', 'Daily Assignment'],
    defaults: { 'Date': '__TODAY__' }
  },
  'Links': {
    required: ['Project ID', 'Link Type', 'URL'],
    defaults: { 'Active': true, 'Sort Order': 10 }
  },
  'Workback': {
    required: ['Project ID', 'Task'],
    defaults: { 'Status': 'Not Started', '% Complete': 0, 'Show on Canvas': true }
  },
  'Deliverables': {
    required: ['Project ID', 'Deliverable'],
    defaults: { 'Status': 'Not Started', 'Sort Order': 10 }
  },
  'Status Log': {
    required: ['Project ID', 'Date', 'Update'],
    defaults: { 'Date': '__TODAY__', 'Visibility': 'Team' }
  }
};

var KIT_HEADER_ROW_ = 4;
var KIT_FILTER_ROW_ = 3;
var KIT_FILTER_COLUMN_ = 2;

/** Adds a small producer utility menu whenever the workbook opens. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Kit')
    .addItem('Add row to this tab', 'showKitAddRowSidebar')
    .addItem('Clear project filter', 'kitClearProjectFilter')
    .addToUi();
}

/** Opens a tab-aware form using the live header row and validation rules. */
function showKitAddRowSidebar() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var config = KIT_SOURCE_SHEET_CONFIG_[sheet.getName()];
  if (!config) {
    SpreadsheetApp.getUi().alert('Open Projects, Project Specs, Daily Assignments, Links, Workback, Deliverables, or Status Log, then try again.');
    return;
  }

  var lastColumn = sheet.getLastColumn();
  var headers = sheet.getRange(KIT_HEADER_ROW_, 1, 1, lastColumn).getDisplayValues()[0];
  var validations = sheet.getRange(KIT_HEADER_ROW_ + 1, 1, 1, lastColumn).getDataValidations()[0];
  var projectIds = getKitProjectIds_();
  var fields = [];

  headers.forEach(function (header, index) {
    if (!header) return;
    var defaultValue = Object.prototype.hasOwnProperty.call(config.defaults || {}, header)
      ? config.defaults[header]
      : '';
    if (defaultValue === '__TODAY__') defaultValue = kitTodayInputValue_();
    fields.push({
      header: header,
      index: index,
      required: (config.required || []).indexOf(header) !== -1,
      defaultValue: defaultValue,
      options: header === 'Project ID' && sheet.getName() !== 'Projects'
        ? projectIds
        : getKitValidationOptions_(validations[index]),
      inputType: getKitInputType_(header)
    });
  });

  var html = HtmlService.createHtmlOutput(buildKitAddRowHtml_(sheet.getName(), fields, config.note || ''))
    .setTitle('Add row — ' + sheet.getName());
  SpreadsheetApp.getUi().showSidebar(html);
}

/** Receives the sidebar payload, validates it, and fills the first open table row. */
function kitAddRowFromSidebar(payload) {
  if (!payload || !payload.sheetName || !KIT_SOURCE_SHEET_CONFIG_[payload.sheetName]) {
    throw new Error('The selected tab is not supported.');
  }

  var spreadsheet = SpreadsheetApp.getActive();
  var sheet = spreadsheet.getSheetByName(payload.sheetName);
  if (!sheet) throw new Error('The selected tab no longer exists.');

  var config = KIT_SOURCE_SHEET_CONFIG_[payload.sheetName];
  var lastColumn = sheet.getLastColumn();
  var headers = sheet.getRange(KIT_HEADER_ROW_, 1, 1, lastColumn).getDisplayValues()[0];
  var submitted = payload.values || {};
  var values = headers.map(function (header) {
    return coerceKitRowValue_(header, submitted[header]);
  });

  (config.required || []).forEach(function (header) {
    var value = submitted[header];
    if (value === null || value === undefined || String(value).trim() === '') {
      throw new Error(header + ' is required.');
    }
  });

  var projectId = String(submitted['Project ID'] || '').trim();
  var projectIds = getKitProjectIds_();
  if (payload.sheetName !== 'Projects' && projectIds.indexOf(projectId) === -1) {
    throw new Error('Project ID ' + projectId + ' was not found in Projects.');
  }

  if (config.uniqueProject) {
    var existing = sheet.getRange(KIT_HEADER_ROW_ + 1, 1, sheet.getMaxRows() - KIT_HEADER_ROW_, 1)
      .getDisplayValues()
      .some(function (row) { return String(row[0]).trim() === projectId; });
    if (existing) throw new Error('Project ID ' + projectId + ' already has a row in ' + payload.sheetName + '.');
  }

  var targetRow = findFirstOpenKitRow_(sheet);
  if (!targetRow) {
    throw new Error('No open rows remain in this tab. Ask a Kit administrator to extend the table.');
  }

  var templateRange = sheet.getRange(KIT_HEADER_ROW_ + 1, 1, 1, lastColumn);
  var targetRange = sheet.getRange(targetRow, 1, 1, lastColumn);
  templateRange.copyTo(targetRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  templateRange.copyTo(targetRange, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  targetRange.clearContent();
  targetRange.setValues([values]);

  // Keep the producer focused on the project they just added.
  sheet.getRange(KIT_FILTER_ROW_, KIT_FILTER_COLUMN_).setValue(projectId);
  applyKitProjectFilter_(sheet, projectId);
  SpreadsheetApp.flush();

  requestKitProjectControlRefreshFromProperties_('sidebar-add-row');
  sheet.activate();
  sheet.getRange(targetRow, 1).activate();
  return { row: targetRow, sheetName: payload.sheetName, projectId: projectId };
}

function kitClearProjectFilter() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (!KIT_SOURCE_SHEET_CONFIG_[sheet.getName()]) {
    SpreadsheetApp.getUi().alert('This tab does not have a project filter.');
    return;
  }
  sheet.getRange(KIT_FILTER_ROW_, KIT_FILTER_COLUMN_).clearContent();
  applyKitProjectFilter_(sheet, '');
  spreadsheetToast_('Showing all rows in ' + sheet.getName());
}

function handleKitProjectFilterEdit_(e, sheet) {
  if (!KIT_SOURCE_SHEET_CONFIG_[sheet.getName()]) return false;
  if (e.range.getRow() !== KIT_FILTER_ROW_ || e.range.getColumn() !== KIT_FILTER_COLUMN_) return false;
  applyKitProjectFilter_(sheet, e.range.getDisplayValue());
  return true;
}

function applyKitProjectFilter_(sheet, rawProjectId) {
  var projectId = String(rawProjectId || '').trim();
  var startRow = KIT_HEADER_ROW_ + 1;
  var rowCount = sheet.getMaxRows() - KIT_HEADER_ROW_;
  if (rowCount <= 0) return;

  sheet.showRows(startRow, rowCount);
  if (!projectId) return;

  var ids = sheet.getRange(startRow, 1, rowCount, 1).getDisplayValues();
  var runStart = null;
  for (var i = 0; i < ids.length; i += 1) {
    var matches = String(ids[i][0] || '').trim() === projectId;
    if (!matches && runStart === null) runStart = startRow + i;
    if (matches && runStart !== null) {
      sheet.hideRows(runStart, startRow + i - runStart);
      runStart = null;
    }
  }
  if (runStart !== null) sheet.hideRows(runStart, startRow + ids.length - runStart);
}

function findFirstOpenKitRow_(sheet) {
  var startRow = KIT_HEADER_ROW_ + 1;
  var rowCount = sheet.getMaxRows() - KIT_HEADER_ROW_;
  var ids = sheet.getRange(startRow, 1, rowCount, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i += 1) {
    if (String(ids[i][0] || '').trim() === '') return startRow + i;
  }
  return null;
}

function getKitProjectIds_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Projects');
  if (!sheet) return [];
  var values = sheet.getRange(KIT_HEADER_ROW_ + 1, 1, sheet.getMaxRows() - KIT_HEADER_ROW_, 1).getDisplayValues();
  var seen = {};
  return values.reduce(function (ids, row) {
    var id = String(row[0] || '').trim();
    if (id && !seen[id]) {
      seen[id] = true;
      ids.push(id);
    }
    return ids;
  }, []);
}

function getKitValidationOptions_(validation) {
  if (!validation) return [];
  try {
    var type = validation.getCriteriaType();
    var args = validation.getCriteriaValues();
    if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
      return (args[0] || []).map(String).filter(Boolean);
    }
    if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE && args[0]) {
      return args[0].getDisplayValues().reduce(function (all, row) {
        return all.concat(row);
      }, []).map(function (value) { return String(value).trim(); }).filter(Boolean);
    }
  } catch (err) {
    Logger.log('[kit] could not read validation options: %s', err && err.message ? err.message : err);
  }
  return [];
}

function getKitInputType_(header) {
  if (/URL|Link/i.test(header)) return 'url';
  if (/Date$|^Date$/i.test(header)) return 'date';
  if (/Notes|Status|Assignment|Update|Requirements|Milestone$/i.test(header)) return 'textarea';
  if (/Sort Order|% Complete/i.test(header)) return 'number';
  return 'text';
}

function coerceKitRowValue_(header, raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  if (/Date$|^Date$/i.test(header) && /^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
    var parts = String(raw).split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  if (header === 'Active' || header === 'Show on Canvas') {
    return raw === true || String(raw).toUpperCase() === 'TRUE';
  }
  if (header === '% Complete') {
    var pct = Number(raw);
    return isNaN(pct) ? raw : (pct > 1 ? pct / 100 : pct);
  }
  if (header === 'Sort Order') {
    var num = Number(raw);
    return isNaN(num) ? raw : num;
  }
  return String(raw).trim();
}

function kitTodayInputValue_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function requestKitProjectControlRefreshFromProperties_(reason) {
  var props = PropertiesService.getScriptProperties();
  var webhookUrl = props.getProperty('WEBHOOK_URL');
  var secret = props.getProperty('WEBHOOK_SECRET');
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  var sheetIds = (props.getProperty('SHEET_IDS') || props.getProperty('SHEET_ID') || '')
    .split(',').map(function (id) { return String(id).trim(); }).filter(Boolean);
  var primarySheetId = props.getProperty('SHEET_ID') || sheetIds[0];
  if (!webhookUrl || !secret || !spreadsheetId || !primarySheetId) return;
  requestKitProjectControlRefresh_(webhookUrl, secret, spreadsheetId, primarySheetId, reason);
}

function spreadsheetToast_(message) {
  SpreadsheetApp.getActive().toast(message, 'Kit', 4);
}

function buildKitAddRowHtml_(sheetName, fields, note) {
  var fieldHtml = fields.map(function (field) {
    var label = escapeKitHtml_(field.header) + (field.required ? ' <span class="required">*</span>' : '');
    var value = field.defaultValue === true
      ? 'TRUE'
      : field.defaultValue === false
        ? 'FALSE'
        : field.defaultValue === null || field.defaultValue === undefined
          ? ''
          : String(field.defaultValue);
    var control;
    if (field.options && field.options.length) {
      var options = ['<option value="">Select…</option>'].concat(field.options.map(function (option) {
        var selected = String(option) === value ? ' selected' : '';
        return '<option value="' + escapeKitHtml_(option) + '"' + selected + '>' + escapeKitHtml_(option) + '</option>';
      })).join('');
      control = '<select data-header="' + escapeKitHtml_(field.header) + '">' + options + '</select>';
    } else if (field.inputType === 'textarea') {
      control = '<textarea rows="3" data-header="' + escapeKitHtml_(field.header) + '">' + escapeKitHtml_(value) + '</textarea>';
    } else {
      var step = field.header === '% Complete' ? ' min="0" max="100" step="1"' : '';
      control = '<input type="' + field.inputType + '" value="' + escapeKitHtml_(value) + '" data-header="' + escapeKitHtml_(field.header) + '"' + step + '>';
    }
    return '<label>' + label + control + '</label>';
  }).join('');

  return '<!doctype html><html><head><base target="_top"><style>' +
    'body{font:13px Arial,sans-serif;color:#1f2933;margin:0;background:#f5f7f8}' +
    '.head{background:#145f82;color:#fff;padding:18px 16px}.head h2{margin:0 0 4px;font-size:18px}.head p{margin:0;opacity:.82}' +
    '.body{padding:14px 16px 90px}.note{background:#e4f0f5;border-left:3px solid #145f82;padding:9px 10px;margin:0 0 14px;line-height:1.35}' +
    'label{display:block;font-weight:700;margin:0 0 12px}.required{color:#c2410c}' +
    'input,select,textarea{box-sizing:border-box;width:100%;margin-top:5px;border:1px solid #b8c2ca;border-radius:5px;background:white;padding:8px;font:13px Arial,sans-serif}' +
    'textarea{resize:vertical}.actions{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #d8dee3;padding:12px 16px}' +
    'button{width:100%;border:0;border-radius:5px;background:#20563f;color:#fff;font-weight:700;padding:10px;cursor:pointer}' +
    'button:disabled{opacity:.55}.status{min-height:18px;margin-top:8px;font-size:12px}.error{color:#b42318}.success{color:#176b46}' +
    '</style></head><body><div class="head"><h2>Add row</h2><p>' + escapeKitHtml_(sheetName) + '</p></div><div class="body">' +
    (note ? '<div class="note">' + escapeKitHtml_(note) + '</div>' : '') + fieldHtml + '</div>' +
    '<div class="actions"><button id="submit" onclick="submitRow()">Add row</button><div id="status" class="status"></div></div>' +
    '<script>function submitRow(){var button=document.getElementById("submit"),status=document.getElementById("status"),values={};' +
    'document.querySelectorAll("[data-header]").forEach(function(el){values[el.getAttribute("data-header")]=el.value;});' +
    'button.disabled=true;status.className="status";status.textContent="Adding row…";' +
    'google.script.run.withSuccessHandler(function(result){status.className="status success";status.textContent="Added row "+result.row+".";setTimeout(function(){google.script.host.close();},700);})' +
    '.withFailureHandler(function(error){button.disabled=false;status.className="status error";status.textContent=(error&&error.message)||String(error);})' +
    '.kitAddRowFromSidebar({sheetName:' + JSON.stringify(sheetName) + ',values:values});}</script></body></html>';
}

function escapeKitHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
