/**
 * Google Sheets + Drive client for Project Control — RAW REST.
 *
 * Uses Node's built-in crypto + fetch, NOT the `googleapis` SDK, because the
 * Bolt/Railway image deliberately does not install googleapis (see
 * bolt/src/onboarding/nda/mailer.ts) and creation runs on Railway. Auth is the
 * existing GOOGLE_SERVICE_ACCOUNT_JSON service account with a directly-granted
 * token (no domain-wide delegation): the SA must be granted Editor on the
 * workbook and the Sheets API enabled.
 *
 * The durable row binding is a Sheets developer-metadata record
 * `kit_project_id=<projects.id>` attached to the row (survives row moves). We
 * never bind by row number, project number, or project name.
 */

import crypto from 'node:crypto'
import { KIT_PROJECT_ID_METADATA_KEY, type WorkbookConfig } from './types'
import {
  MASTER_HEADERS,
  RF_PRODUCTION_PROJECT_HEADERS,
  headerToA1Column,
  normalizeCell,
  type SheetCell,
  type OwnedCell,
  parseDateToSerial,
} from './render'
import { generateWorkback } from './workback'
import type { CreationSubmission } from './render'
import type { ProjectSupplement } from './views'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ')
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files'
// Bounded: an unbounded Sheets/Drive call could hang past the creation/sync
// lease and let a reclaiming worker run concurrently.
const GOOGLE_CALL_TIMEOUT_MS = 15_000

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function getServiceAccountCreds(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set')
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf-8')
  const creds = JSON.parse(json)
  if (!creds.client_email || !creds.private_key) {
    throw new Error('service account JSON missing client_email / private_key')
  }
  return creds
}

let cachedToken: { token: string; exp: number } | null = null

/** Mint (and cache) a service-account access token for the Sheets+Drive scopes. */
async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token
  const creds = getServiceAccountCreds()
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(
    JSON.stringify({ iss: creds.client_email, scope: SCOPES, aud: TOKEN_ENDPOINT, iat: now, exp: now + 3600 }),
  )
  const signingInput = `${header}.${claim}`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), creds.private_key)
  const assertion = `${signingInput}.${b64url(signature)}`
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(GOOGLE_CALL_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`)
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('Google token exchange returned no access_token')
  cachedToken = { token: data.access_token, exp: now + (data.expires_in || 3600) }
  return cachedToken.token
}

/**
 * Read a bounded A1 range from any spreadsheet the configured service account
 * can access. This is intentionally small and read-only; the legacy Project
 * Control migration uses it to reconcile the former production workbook before
 * adopting rows in the new authoritative workbook.
 */
export async function readSpreadsheetValues(
  spreadsheetId: string,
  range: string,
): Promise<Array<Array<string | number | boolean>>> {
  const encodedRange = encodeURIComponent(range)
  const data = await api<{ values?: Array<Array<string | number | boolean>> }>(
    'GET',
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodedRange}?valueRenderOption=FORMATTED_VALUE`,
  )
  return data.values || []
}

type Transport = <T>(method: string, url: string, body?: unknown) => Promise<T>

async function httpTransport<T>(method: string, url: string, body?: unknown): Promise<T> {
  const token = await getAccessToken()
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(GOOGLE_CALL_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Google ${method} ${url.split('?')[0]} failed (${res.status}): ${await res.text()}`)
  return (await res.json()) as T
}

let transport: Transport = httpTransport

const RETRYABLE_GOOGLE_STATUS_RE = /failed \((?:429|500|502|503|504)\)/
const GOOGLE_READ_RETRY_DELAYS_MS = [250, 1_000]

/** Test seam: swap the HTTP transport for a fake. Pass null to restore. */
export function __setSheetsTransportForTests(t: Transport | null): void {
  transport = t || httpTransport
}

function isRetrySafeGoogleRequest(method: string, url: string): boolean {
  return method === 'GET' || url.includes(':getByDataFilter') || url.includes('developerMetadata:search')
}

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const retrySafe = isRetrySafeGoogleRequest(method, url)
  for (let attempt = 0; ; attempt++) {
    try {
      return await transport<T>(method, url, body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const delay = GOOGLE_READ_RETRY_DELAYS_MS[attempt]
      if (!retrySafe || delay == null || !RETRYABLE_GOOGLE_STATUS_RE.test(message)) throw err
      console.warn(`[project-control] transient Google read failure; retrying in ${delay}ms (${attempt + 1}/${GOOGLE_READ_RETRY_DELAYS_MS.length})`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

// Narrow shapes of the Google REST responses we read (not the full API types).
interface DriveFileResponse { version?: string }
interface DevMetadata { metadataId?: number; location?: { dimensionRange?: { startIndex?: number; sheetId?: number } } }
interface DevMetadataSearchResponse { matchedDeveloperMetadata?: Array<{ developerMetadata?: DevMetadata }> }
/** getByDataFilter response — includes each returned sheet's numeric id so the
 *  caller can pick the CONFIGURED sheet deterministically (never tab order). */
interface SheetDataFilterResponse {
  sheets?: Array<{
    properties?: { sheetId?: number }
    data?: Array<{ rowData?: Array<{ values?: SheetCell[] }> }>
  }>
}
interface SpreadsheetMetadataResponse {
  sheets?: Array<{
    properties?: {
      sheetId?: number
      gridProperties?: { rowCount?: number }
    }
    tables?: Array<{
      tableId?: string
      range?: {
        sheetId?: number
        startRowIndex?: number
        endRowIndex?: number
        startColumnIndex?: number
        endColumnIndex?: number
      }
    }>
  }>
}
interface BatchUpdateResponse {
  replies?: Array<{ createDeveloperMetadata?: { developerMetadata?: { metadataId?: number } } }>
}

async function getSheetRowCount(config: WorkbookConfig, sheetId: number): Promise<number> {
  const fields = encodeURIComponent('sheets(properties(sheetId,gridProperties(rowCount)))')
  const data = await api<SpreadsheetMetadataResponse>(
    'GET',
    `${SHEETS_BASE}/${config.spreadsheetId}?fields=${fields}`,
  )
  const rowCount = data.sheets
    ?.find((sheet) => sheet.properties?.sheetId === sheetId)
    ?.properties?.gridProperties?.rowCount
  if (rowCount == null) throw new Error(`getSheetRowCount: configured sheet ${sheetId} not found`)
  return rowCount
}

interface NativeTable {
  tableId: string
  range: {
    sheetId: number
    startRowIndex: number
    endRowIndex: number
    startColumnIndex: number
    endColumnIndex: number
  }
}

/** Return the normalized source table on a sheet, when one exists. */
async function getNativeTable(config: WorkbookConfig, sheetId: number): Promise<NativeTable | null> {
  if (config.layout !== 'rf-production-v1') return null
  const fields = encodeURIComponent('sheets(properties(sheetId),tables(tableId,range))')
  const data = await api<SpreadsheetMetadataResponse>(
    'GET',
    `${SHEETS_BASE}/${config.spreadsheetId}?fields=${fields}`,
  )
  const sheet = data.sheets?.find((candidate) => candidate.properties?.sheetId === sheetId)
  const table = sheet?.tables?.find((candidate) => {
    const range = candidate.range
    return range?.sheetId === sheetId &&
      range.startRowIndex != null && range.endRowIndex != null &&
      range.startColumnIndex != null && range.endColumnIndex != null &&
      // The configured first data row must immediately follow the table header.
      range.startRowIndex + 1 === config.headerRow
  })
  const range = table?.range
  if (!table?.tableId || !range || range.sheetId == null || range.startRowIndex == null ||
      range.endRowIndex == null || range.startColumnIndex == null || range.endColumnIndex == null) return null
  return {
    tableId: table.tableId,
    range: {
      sheetId: range.sheetId,
      startRowIndex: range.startRowIndex,
      endRowIndex: range.endRowIndex,
      startColumnIndex: range.startColumnIndex,
      endColumnIndex: range.endColumnIndex,
    },
  }
}

function expandTableRequest(table: NativeTable | null, endRowIndex: number): unknown | null {
  if (!table || endRowIndex <= table.range.endRowIndex) return null
  return {
    updateTable: {
      table: {
        tableId: table.tableId,
        range: { ...table.range, endRowIndex },
      },
      fields: 'range',
    },
  }
}

/**
 * The ONE mechanism for reading Project Control cell data: a `getByDataFilter`
 * GridRange keyed by the numeric CONFIGURED sheetId. Unlike an unqualified A1
 * range (e.g. `A4:Y4`), this can never resolve against the first *visible* tab —
 * it targets exactly `config.sheetId`, re-selects the returned sheet by
 * `properties.sheetId`, and fails closed if that sheet is absent. Every row read
 * (single row, single column, occupancy scan) goes through here so there is no
 * second Sheet-reading implementation to drift.
 */
type GridRange = {
  startRowIndex?: number
  endRowIndex?: number
  startColumnIndex?: number
  endColumnIndex?: number
}

async function getGridData(
  config: WorkbookConfig,
  range: GridRange,
  valueFields: string,
  sheetId = config.sheetId,
): Promise<Array<{ values?: SheetCell[] }>> {
  const fields = encodeURIComponent(`sheets(properties.sheetId,data(rowData(values(${valueFields}))))`)
  const data = await api<SheetDataFilterResponse>(
    'POST',
    `${SHEETS_BASE}/${config.spreadsheetId}:getByDataFilter?fields=${fields}`,
    { dataFilters: [{ gridRange: { sheetId, ...range } }], includeGridData: true },
  )
  const sheet = (data.sheets || []).find((s) => s.properties?.sheetId === sheetId)
  if (!sheet) {
    throw new Error(`getGridData: configured sheet ${sheetId} not found in getByDataFilter response`)
  }
  return sheet.data?.[0]?.rowData || []
}

/** Coarse cursor: the Drive file version of the workbook. */
export async function getWorkbookVersion(spreadsheetId: string): Promise<string> {
  const data = await api<DriveFileResponse>('GET', `${DRIVE_BASE}/${spreadsheetId}?fields=version&supportsAllDrives=true`)
  return String(data.version || '')
}

export interface RowMetadataMatch {
  metadataId: number
  /** 0-based grid row index. */
  rowIndex: number
  /** The sheet the metadata (and therefore the bound row) lives on. */
  sheetId: number
}

/**
 * Find the row bound to a project via developer metadata, ON THE CONFIGURED
 * SHEET.
 *
 * The developer-metadata search is spreadsheet-wide, so a match can carry a
 * `dimensionRange.sheetId` for a DIFFERENT tab. The authoritative project row
 * must live on `sheetId`; a match on any other sheet must never be treated as
 * authoritative (else sync/creation would read a row number from the wrong tab).
 *
 * Behaviour:
 *   - no metadata anywhere        → null   (unbound; a retry may create the row)
 *   - a match on `sheetId`        → that match (with its sheetId)
 *   - matches only on OTHER sheets → THROW (fail closed, visible). Never returns
 *     a wrong-sheet row number, preserving one-project/one-row on the configured
 *     sheet. Callers surface this as an error (sync) rather than a canvas edit.
 */
export async function searchRowMetadata(
  spreadsheetId: string,
  kitProjectId: string,
  sheetId: number,
): Promise<RowMetadataMatch | null> {
  const data = await api<DevMetadataSearchResponse>(
    'POST',
    `${SHEETS_BASE}/${spreadsheetId}/developerMetadata:search`,
    { dataFilters: [{ developerMetadataLookup: { metadataKey: KIT_PROJECT_ID_METADATA_KEY, metadataValue: kitProjectId } }] },
  )
  const matched = data.matchedDeveloperMetadata || []
  const parsed: RowMetadataMatch[] = []
  for (const m of matched) {
    const dm = m.developerMetadata
    const start = dm?.location?.dimensionRange?.startIndex
    const dmSheet = dm?.location?.dimensionRange?.sheetId
    if (dm?.metadataId == null || start == null || dmSheet == null) continue
    parsed.push({ metadataId: dm.metadataId, rowIndex: start, sheetId: dmSheet })
  }
  if (parsed.length === 0) return null
  const onSheet = parsed.find((p) => p.sheetId === sheetId)
  if (onSheet) return onSheet
  // A match exists, but only on other tab(s). Fail closed, visibly — never read
  // a matching row number from the wrong sheet.
  const others = [...new Set(parsed.map((p) => p.sheetId))].join(',')
  throw new Error(
    `row metadata for ${kitProjectId} found on sheet(s) ${others}, not the configured sheet ${sheetId}`,
  )
}

/**
 * Read one row's cells (A:Y) from the CONFIGURED sheet, with the metadata needed
 * to normalize them. Targets `config.sheetId` deterministically (see
 * `getGridData`) so it can never read the same row index from the wrong tab.
 */
export async function readRow(config: WorkbookConfig, rowIndex: number): Promise<SheetCell[]> {
  if (config.layout === 'rf-production-v1') return readRfProductionRow(config, rowIndex)
  const rowData = await getGridData(
    config,
    { startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: MASTER_HEADERS.length },
    'formattedValue,effectiveValue,userEnteredValue,hyperlink,effectiveFormat.numberFormat.type',
  )
  const values = rowData[0]?.values || []
  const cells: SheetCell[] = []
  for (let i = 0; i < MASTER_HEADERS.length; i++) cells.push((values[i] as SheetCell) || {})
  return cells
}

function textCell(value: string | null | undefined): SheetCell {
  return value ? { formattedValue: value, effectiveValue: { stringValue: value } } : {}
}

function projectNumberFromCell(cell: SheetCell | undefined): string {
  return normalizeCell(cell).display.trim()
}

function normalizeLinkType(value: string): 'Frame.io' | 'Dropbox' | 'Harvest' | 'Boords' | null {
  const v = value.trim().toLowerCase()
  if (v === 'frame.io' || v === 'frameio') return 'Frame.io'
  if (v === 'dropbox' || v.startsWith('dropbox ')) return 'Dropbox'
  if (v === 'harvest') return 'Harvest'
  if (v === 'boords') return 'Boords'
  return null
}

async function readRfLinkRows(config: WorkbookConfig): Promise<Array<{ rowIndex: number; projectNumber: string; type: string; url: string }>> {
  if (config.linksSheetId == null) return []
  const firstDataRowIndex = config.linksHeaderRow ?? config.headerRow
  const data = await getGridData(
    config,
    { startRowIndex: firstDataRowIndex, startColumnIndex: 0, endColumnIndex: 4 },
    'formattedValue,effectiveValue,userEnteredValue,hyperlink',
    config.linksSheetId,
  )
  return data.map((rd, i) => ({
    rowIndex: firstDataRowIndex + i,
    projectNumber: normalizeCell(rd.values?.[0]).display.trim(),
    type: normalizeCell(rd.values?.[1]).display.trim(),
    url: normalizeCell(rd.values?.[3]).hyperlink || normalizeCell(rd.values?.[3]).display.trim(),
  }))
}

/** Translate the RF Production Projects + Links tabs into the stable A:Y
 * semantic row consumed by the Canvas renderer and row hash. */
async function readRfProductionRow(config: WorkbookConfig, rowIndex: number): Promise<SheetCell[]> {
  const rowData = await getGridData(
    config,
    { startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: RF_PRODUCTION_PROJECT_HEADERS.length },
    'formattedValue,effectiveValue,userEnteredValue,hyperlink,effectiveFormat.numberFormat.type',
  )
  const physical = rowData[0]?.values || []
  const out: SheetCell[] = MASTER_HEADERS.map(() => ({}))
  const put = (semantic: typeof MASTER_HEADERS[number], physicalIndex: number) => {
    out[MASTER_HEADERS.indexOf(semantic)] = physical[physicalIndex] || {}
  }
  put('Project Number', 0)
  put('Client', 1)
  put('Project Name', 2)
  put('Client Contact', 3)
  put('Status', 5)
  put('Quick Status', 7)
  put('Next Share', 8)
  put('Start Date', 10)
  put('End Date', 11)
  put('Creative Director', 12)
  put('Producer', 13)
  put('VO', 14)
  put('Music', 15)
  const lastShareLabel = physical[16] || physical[17] || {}
  const lastShareUrl = normalizeCell(physical[17]).hyperlink || normalizeCell(physical[17]).display.trim()
  out[MASTER_HEADERS.indexOf('Last Share')] = lastShareUrl ? { ...lastShareLabel, hyperlink: lastShareUrl } : lastShareLabel

  const projectNumber = projectNumberFromCell(physical[0])
  if (projectNumber && config.linksSheetId != null) {
    const links = await readRfLinkRows(config)
    for (const link of links) {
      if (link.projectNumber !== projectNumber) continue
      const type = normalizeLinkType(link.type)
      if ((type === 'Frame.io' || type === 'Dropbox') && link.url) out[MASTER_HEADERS.indexOf(type)] = textCell(link.url)
    }
  }
  return out
}

/**
 * Locate the next writable row (0-based grid index) ON THE CONFIGURED SHEET:
 * the first fully-empty row at/after the data region. Legacy workbooks use
 * column A (Project Number) as their occupancy signal. The RF Production
 * workbook checks every physical Projects column (A:O), because imported rows
 * can contain a project name or section content while Project ID is blank.
 * Deterministic and non-destructive — never a blind full-width append. Uses the
 * same sheetId-keyed read as every other row read, so the creation write-row is
 * chosen from `config.sheetId`, never the first visible tab.
 */
async function findNextEmptyRowIndex(config: WorkbookConfig): Promise<number> {
  const firstDataRowIndex = config.headerRow // 0-based grid index of the first data row
  const physicalColumnCount = config.layout === 'rf-production-v1' ? RF_PRODUCTION_PROJECT_HEADERS.length : 1
  const rowData = await getGridData(
    config,
    { startRowIndex: firstDataRowIndex, startColumnIndex: 0, endColumnIndex: physicalColumnCount },
    'formattedValue,effectiveValue',
  )
  let offset = rowData.findIndex((rd) => {
    const values = rd?.values || []
    return Array.from(
      { length: physicalColumnCount },
      (_, columnIndex) => normalizeCell(values[columnIndex]).display.trim(),
    ).every((value) => value === '')
  })
  if (offset < 0) offset = rowData.length
  return firstDataRowIndex + offset
}

export interface CreateBoundRowResult {
  metadataId: number
  rowIndex: number
  alreadyBound: boolean
}

/** Fields copied from the former production workbook during the one-time
 * Project Control cutover. Only non-empty source values are written. */
export interface LegacyProjectRowSeed {
  projectNumber: string
  client?: string
  projectName?: string
  clientContact?: string
  projectType?: string
  lifecycle?: string
  phase?: string
  currentStatus?: string
  nextMilestone?: string
  startDate?: string
  deliveryDate?: string
  creativeDirector?: string
  producer?: string
  previousNotes?: string
}

function legacySeedRequests(config: WorkbookConfig, rowIndex: number, seed: LegacyProjectRowSeed): unknown[] {
  const values: Array<{ columnIndex: number; value?: string; date?: string }> = [
    { columnIndex: 0, value: seed.projectNumber },
    { columnIndex: 1, value: seed.client },
    { columnIndex: 2, value: seed.projectName },
    { columnIndex: 3, value: seed.clientContact },
    { columnIndex: 4, value: seed.projectType },
    { columnIndex: 5, value: seed.lifecycle },
    { columnIndex: 6, value: seed.phase },
    { columnIndex: 7, value: seed.currentStatus },
    { columnIndex: 8, value: seed.nextMilestone },
    { columnIndex: 10, date: seed.startDate },
    { columnIndex: 11, date: seed.deliveryDate },
    { columnIndex: 12, value: seed.creativeDirector },
    { columnIndex: 13, value: seed.producer },
    { columnIndex: 19, value: seed.previousNotes },
  ]
  const requests: unknown[] = []
  for (const item of values) {
    if (item.date) {
      const serial = parseDateToSerial(item.date)
      if (serial == null) continue
      requests.push({
        updateCells: {
          rows: [{ values: [{
            userEnteredValue: { numberValue: serial },
            userEnteredFormat: { numberFormat: { type: 'DATE' } },
          }] }],
          fields: 'userEnteredValue,userEnteredFormat.numberFormat',
          start: { sheetId: config.sheetId, rowIndex, columnIndex: item.columnIndex },
        },
      })
      continue
    }
    const value = item.value?.trim()
    if (!value) continue
    requests.push({
      updateCells: {
        rows: [{ values: [{ userEnteredValue: { stringValue: value } }] }],
        fields: 'userEnteredValue',
        start: { sheetId: config.sheetId, rowIndex, columnIndex: item.columnIndex },
      },
    })
  }
  return requests
}

/**
 * Adopt the unique existing Projects row for a legacy project number, or seed
 * a new row when none exists, then attach the durable kit_project_id metadata.
 * This prevents the cutover from appending duplicate rows beneath the workbook
 * tables. A duplicate project number fails closed for manual review.
 */
export async function adoptLegacyProjectRow(
  config: WorkbookConfig,
  kitProjectId: string,
  seed: LegacyProjectRowSeed,
): Promise<CreateBoundRowResult> {
  if (config.layout !== 'rf-production-v1') {
    throw new Error('adoptLegacyProjectRow requires rf-production-v1')
  }
  let already: RowMetadataMatch | null = null
  try {
    already = await searchRowMetadata(config.spreadsheetId, kitProjectId, config.sheetId)
  } catch (error) {
    // A duplicate workbook can retain developer metadata on its copied legacy
    // tab. Normal reads must fail closed in that situation, but this explicit
    // cutover operation exists to adopt the normalized Projects row. Once the
    // configured-row metadata is attached, normal search deterministically
    // selects it and continues to ignore the legacy tab.
    if (!String(error).includes('not the configured sheet')) throw error
  }
  let rowIndex: number
  let metadataId: number | null = already?.metadataId ?? null
  if (already) {
    rowIndex = already.rowIndex
  } else {
    const firstDataRowIndex = config.headerRow
    const rows = await getGridData(
      config,
      { startRowIndex: firstDataRowIndex, startColumnIndex: 0, endColumnIndex: 1 },
      'formattedValue,effectiveValue',
    )
    const wanted = seed.projectNumber.trim().toLowerCase()
    const matches: number[] = []
    rows.forEach((row, offset) => {
      if (normalizeCell(row.values?.[0]).display.trim().toLowerCase() === wanted) {
        matches.push(firstDataRowIndex + offset)
      }
    })
    if (matches.length > 1) {
      throw new Error(`legacy adoption ambiguous: ${seed.projectNumber} appears on rows ${matches.map((x) => x + 1).join(',')}`)
    }
    rowIndex = matches[0] ?? await findNextEmptyRowIndex(config)
  }

  const requests = legacySeedRequests(config, rowIndex, seed)
  const table = await getNativeTable(config, config.sheetId)
  const tableExpansion = expandTableRequest(table, rowIndex + 1)
  if (tableExpansion) requests.push(tableExpansion)
  if (!already) {
    requests.push({
      createDeveloperMetadata: {
        developerMetadata: {
          metadataKey: KIT_PROJECT_ID_METADATA_KEY,
          metadataValue: kitProjectId,
          visibility: 'DOCUMENT',
          location: {
            dimensionRange: {
              sheetId: config.sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        },
      },
    })
  }
  if (requests.length) {
    const data = await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, { requests })
    if (!already) {
      const metaReply = (data.replies || []).find((r) => r.createDeveloperMetadata)
      metadataId = metaReply?.createDeveloperMetadata?.developerMetadata?.metadataId ?? null
    }
  }
  if (metadataId == null) throw new Error('adoptLegacyProjectRow: no developer metadata id returned')
  return { metadataId, rowIndex, alreadyBound: Boolean(already) }
}

/** Remove only the row metadata belonging to a discarded migration duplicate.
 * Cell values and the row itself are intentionally preserved. */
export async function deleteProjectRowMetadata(
  config: WorkbookConfig,
  kitProjectId: string,
): Promise<void> {
  await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, {
    requests: [{
      deleteDeveloperMetadata: {
        dataFilter: {
          developerMetadataLookup: {
            metadataKey: KIT_PROJECT_ID_METADATA_KEY,
            metadataValue: kitProjectId,
            visibility: 'DOCUMENT',
          },
        },
      },
    }],
  })
}

/**
 * Build the per-cell `updateCells` batchUpdate requests for a set of owned cells
 * at a row. Shared by createBoundRow and updateBoundRow so the date-vs-string
 * handling and `fields` masks live in ONE place.
 *
 * Date cells: write the serial number AND explicitly set a DATE number format in
 * the same atomic request, so the value is a real date (never locale text).
 * String cells: write value only (`fields:'userEnteredValue'` preserves the
 * cell's existing format + validation).
 */
function buildCellRequests(config: WorkbookConfig, rowIndex: number, ownedCells: OwnedCell[]): unknown[] {
  return ownedCells.map((cell) => {
    // OwnedCell already carries the schema-resolved physical column. Using it
    // directly also supports RF-only fields (Project Type) that intentionally
    // have no legacy semantic header.
    const start = { sheetId: config.sheetId, rowIndex, columnIndex: cell.column.charCodeAt(0) - 'A'.charCodeAt(0) }
    if (cell.kind === 'date' && typeof cell.serial === 'number') {
      return {
        updateCells: {
          rows: [{ values: [{
            userEnteredValue: { numberValue: cell.serial },
            userEnteredFormat: { numberFormat: { type: 'DATE' } },
          }] }],
          fields: 'userEnteredValue,userEnteredFormat.numberFormat',
          start,
        },
      }
    }
    return {
      updateCells: {
        rows: [{ values: [{ userEnteredValue: { stringValue: cell.value } }] }],
        fields: 'userEnteredValue',
        start,
      },
    }
  })
}

/**
 * Atomically create/prepare the row, write only Kit-owned cells, and attach the
 * kit_project_id developer metadata — all in ONE spreadsheets.batchUpdate so a
 * partial write is impossible. Searches metadata first for idempotency.
 *
 * `updateCells` with fields:'userEnteredValue' writes values without touching
 * cell formatting or data validation. Margin formula columns are never in
 * `ownedCells` (guaranteed by kitOwnedCreationCells).
 */
export async function createBoundRow(
  config: WorkbookConfig,
  kitProjectId: string,
  ownedCells: OwnedCell[],
): Promise<CreateBoundRowResult> {
  const existing = await searchRowMetadata(config.spreadsheetId, kitProjectId, config.sheetId)
  if (existing) return { metadataId: existing.metadataId, rowIndex: existing.rowIndex, alreadyBound: true }

  const rowIndex = await findNextEmptyRowIndex(config)
  const table = await getNativeTable(config, config.sheetId)

  const requests: unknown[] = buildCellRequests(config, rowIndex, ownedCells)
  const tableExpansion = expandTableRequest(table, rowIndex + 1)
  if (tableExpansion) requests.push(tableExpansion)
  requests.push({
    createDeveloperMetadata: {
      developerMetadata: {
        metadataKey: KIT_PROJECT_ID_METADATA_KEY,
        metadataValue: kitProjectId,
        visibility: 'DOCUMENT',
        location: {
          dimensionRange: {
            sheetId: config.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      },
    },
  })

  const data = await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, { requests })
  const replies = data.replies || []
  const metaReply = replies.find((r) => r.createDeveloperMetadata)
  const metadataId = metaReply?.createDeveloperMetadata?.developerMetadata?.metadataId
  if (metadataId == null) throw new Error('createBoundRow: batchUpdate returned no developer metadata id')
  return { metadataId, rowIndex, alreadyBound: false }
}

export type UpdateBoundRowResult = { rowIndex: number } | { skipped: 'unbound' }

/**
 * Rewrite the Kit-owned cells of an ALREADY-bound row when a project is updated.
 * Mirrors `createBoundRow`'s per-cell `updateCells` requests (same date/string
 * handling, same `fields` masks that preserve formatting + validation) but:
 *   - resolves the row via the durable developer metadata (never a row number);
 *   - writes NO developer metadata (the binding already exists);
 *   - returns `{ skipped: 'unbound' }` when the project has no bound row (e.g. it
 *     was created with Project Control disabled) — the caller treats that as a
 *     no-op, not a failure.
 *
 * Writing the full owned-cell set is idempotent; margin/formula columns are never
 * included (guaranteed by kitOwnedCreationCells). The Master Project List stays
 * authoritative and the Canvas re-renders from it via the existing sync.
 */
export async function updateBoundRow(
  config: WorkbookConfig,
  kitProjectId: string,
  ownedCells: OwnedCell[],
): Promise<UpdateBoundRowResult> {
  const existing = await searchRowMetadata(config.spreadsheetId, kitProjectId, config.sheetId)
  if (!existing) return { skipped: 'unbound' }
  const rowIndex = existing.rowIndex

  const requests: unknown[] = buildCellRequests(config, rowIndex, ownedCells)

  if (requests.length > 0) {
    await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, { requests })
  }
  return { rowIndex }
}

export interface ProjectLinksInput {
  frameioUrl?: string
  dropboxUrl?: string
  harvestUrl?: string
  boordsUrl?: string
}

/** Upsert Kit-owned provider links in RF Production's normalized Links tab.
 * Existing human labels (for example "Dropbox (client folder)") are preserved;
 * only the URL changes. New rows use the workbook's canonical link labels. */
export async function upsertProjectLinks(
  config: WorkbookConfig,
  projectNumber: string | undefined,
  links: ProjectLinksInput,
): Promise<void> {
  if (config.layout !== 'rf-production-v1' || config.linksSheetId == null || !projectNumber?.trim()) return
  const desired = [
    { type: 'Frame.io' as const, url: links.frameioUrl?.trim() },
    { type: 'Dropbox' as const, url: links.dropboxUrl?.trim() },
    { type: 'Harvest' as const, url: links.harvestUrl?.trim() },
    { type: 'Boords' as const, url: links.boordsUrl?.trim() },
  ].filter((x): x is { type: 'Frame.io' | 'Dropbox' | 'Harvest' | 'Boords'; url: string } => Boolean(x.url))
  if (desired.length === 0) return

  const rows = await readRfLinkRows(config)
  const occupied = new Set(rows.filter((r) => r.projectNumber).map((r) => r.rowIndex))
  let next = config.linksHeaderRow ?? config.headerRow
  const allocate = (): number => {
    while (occupied.has(next)) next++
    occupied.add(next)
    return next++
  }
  const requests: unknown[] = []
  for (const link of desired) {
    const existing = rows.find((r) => r.projectNumber === projectNumber.trim() && normalizeLinkType(r.type) === link.type)
    if (existing) {
      requests.push({
        updateCells: {
          rows: [{ values: [{ userEnteredValue: { stringValue: link.url } }] }],
          fields: 'userEnteredValue',
          start: { sheetId: config.linksSheetId, rowIndex: existing.rowIndex, columnIndex: 3 },
        },
      })
      continue
    }
    const rowIndex = allocate()
    requests.push({
      updateCells: {
        rows: [{ values: [
          { userEnteredValue: { stringValue: projectNumber.trim() } },
          { userEnteredValue: { stringValue: link.type } },
          { userEnteredValue: { stringValue: link.type } },
          { userEnteredValue: { stringValue: link.url } },
          { userEnteredValue: { boolValue: true } },
          { userEnteredValue: { numberValue: link.type === 'Dropbox' ? 10 : link.type === 'Frame.io' ? 20 : link.type === 'Boords' ? 50 : 90 } },
        ] }],
        fields: 'userEnteredValue',
        start: { sheetId: config.linksSheetId, rowIndex, columnIndex: 0 },
      },
    })
  }
  await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, { requests })
}

type PlainValue = string | number | boolean | null | undefined

function userValue(value: PlainValue): Record<string, unknown> {
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') return { numberValue: value }
  return { stringValue: value == null ? '' : String(value) }
}

async function appendRows(config: WorkbookConfig, sheetId: number, width: number, rows: PlainValue[][]): Promise<void> {
  if (rows.length === 0) return
  const firstDataRowIndex = config.headerRow
  // Column A is the normalized tables' durable occupancy key (Project ID).
  // Other columns may contain prefilled formulas all the way to the grid edge;
  // treating those as occupied pushes the append one row beyond the sheet.
  const existing = await getGridData(
    config,
    { startRowIndex: firstDataRowIndex, startColumnIndex: 0, endColumnIndex: 1 },
    'formattedValue,effectiveValue',
    sheetId,
  )
  const lastOccupied = existing.reduce((last, r, index) =>
    normalizeCell(r.values?.[0]).display.trim() ? index : last, -1)
  const rowIndex = firstDataRowIndex + lastOccupied + 1
  const rowCount = await getSheetRowCount(config, sheetId)
  const table = await getNativeTable(config, sheetId)
  const missingRows = Math.max(0, rowIndex + rows.length - rowCount)
  const requests: unknown[] = []
  if (missingRows > 0) {
    requests.push({ appendDimension: { sheetId, dimension: 'ROWS', length: missingRows } })
  }
  requests.push({ updateCells: {
    start: { sheetId, rowIndex, columnIndex: 0 },
    rows: rows.map((row) => ({ values: row.map((value) => ({ userEnteredValue: userValue(value) })) })),
    fields: 'userEnteredValue',
  } })
  const tableExpansion = expandTableRequest(table, rowIndex + rows.length)
  if (tableExpansion) requests.push(tableExpansion)
  await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, {
    requests,
  })
}

async function sheetHasProject(config: WorkbookConfig, sheetId: number, projectNumber: string): Promise<boolean> {
  const data = await getGridData(config, { startRowIndex: config.headerRow, startColumnIndex: 0, endColumnIndex: 1 }, 'formattedValue,effectiveValue', sheetId)
  return data.some((r) => normalizeCell(r.values?.[0]).display.trim() === projectNumber)
}

async function readTableForProject(config: WorkbookConfig, sheetId: number | undefined, headers: readonly string[], projectNumber: string): Promise<Array<Record<string, string>>> {
  if (sheetId == null) return []
  const data = await getGridData(config, { startRowIndex: config.headerRow, startColumnIndex: 0, endColumnIndex: headers.length }, 'formattedValue,effectiveValue,hyperlink', sheetId)
  return data.flatMap((r) => {
    if (normalizeCell(r.values?.[0]).display.trim() !== projectNumber) return []
    const row: Record<string, string> = {}
    headers.forEach((h, i) => {
      const n = normalizeCell(r.values?.[i])
      const serial = r.values?.[i]?.effectiveValue?.numberValue
      const date = /date/i.test(h) && typeof serial === 'number'
        ? new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10)
        : null
      // A formatted label can carry a stale hyperlink (the production sheet's
      // "Frame.io" Link Type cell is one example). Only URL-bearing schema
      // columns should prefer CellData.hyperlink; identity/type labels must
      // remain their displayed text or downstream field matching breaks.
      const isLinkValue = /(^url$| url$| link$)/i.test(h)
      row[h] = (isLinkValue ? n.hyperlink : null) || date || n.display
    })
    return [row]
  })
}

export async function readProjectSupplement(config: WorkbookConfig, projectNumber: string): Promise<ProjectSupplement> {
  const [projectRows, specRows, workback, links, deliverables, assignments] = await Promise.all([
    readTableForProject(config, config.sheetId, RF_PRODUCTION_PROJECT_HEADERS, projectNumber),
    readTableForProject(config, config.specsSheetId, ['Project ID','Dimensions','Frame Rate','Duration','Audio Requirements','Primary File Type','Notes','Specs Status'], projectNumber),
    readTableForProject(config, config.workbackSheetId, ['Project ID','Task','Phase','Start Date','Due Date','Owner','Status','% Complete','Notes','Milestone URL','Sort Order','Show on Canvas'], projectNumber),
    readTableForProject(config, config.linksSheetId, ['Project ID','Link Type','Label','URL','Active','Sort Order'], projectNumber),
    readTableForProject(config, config.deliverablesSheetId, ['Project ID','Deliverable','Specs','Delivery Link','Status','Sort Order'], projectNumber),
    readTableForProject(config, config.assignmentsSheetId, ['Project ID','Date','Person','Role','Phase','Daily Assignment'], projectNumber),
  ])
  return {
    scheduleStatus: projectRows[0]?.['Schedule Status'] || 'Draft',
    specs: specRows[0] || {}, workback, links, deliverables, assignments,
  }
}

/** Seed every normalized source table once. The Projects row remains bound by
 * developer metadata; child tables are idempotent by Project ID. */
export async function seedNormalizedProjectTables(config: WorkbookConfig, submission: CreationSubmission): Promise<void> {
  if (config.layout !== 'rf-production-v1' || !submission.projectNumber) return
  const id = submission.projectNumber.trim()
  await upsertProjectLinks(config, id, submission)

  if (config.specsSheetId != null && !(await sheetHasProject(config, config.specsSheetId, id))) {
    await appendRows(config, config.specsSheetId, 8, [[id, '', '', '', '', '', '', 'Needs Review']])
  }

  if (config.workbackSheetId != null && submission.startDate && submission.deadline && !(await sheetHasProject(config, config.workbackSheetId, id))) {
    const rows = generateWorkback({
      startDate: submission.startDate,
      deliveryDate: submission.deadline,
      milestoneCount: submission.milestoneCount || 9,
      template: submission.workbackTemplate || 'Standard Sizzle',
      milestoneNames: submission.milestoneNames,
    })
    await appendRows(config, config.workbackSheetId, 12, rows.map((row) => [
      id, row.task, row.phase, parseDateToSerial(row.startDate), parseDateToSerial(row.dueDate), submission.producerName || '', row.status,
      row.percentComplete, '', '', row.sortOrder, true,
    ]))
  }

  if (config.deliverablesSheetId != null && !(await sheetHasProject(config, config.deliverablesSheetId, id))) {
    await appendRows(config, config.deliverablesSheetId, 6, [
      [id, 'Main', '', '', 'Planned', 10],
      [id, 'Caption', '', '', 'Planned', 20],
      [id, 'Accessibility Files', '', '', 'Planned', 30],
      [id, 'Thumbnails', '', '', 'Planned', 40],
    ])
  }
  if (config.statusLogSheetId != null && !(await sheetHasProject(config, config.statusLogSheetId, id))) {
    await appendRows(config, config.statusLogSheetId, 4, [[id, parseDateToSerial(new Date().toISOString().slice(0, 10)), 'Project created by Kit', 'Kit']])
  }
}

/** Record the newest Frame.io review as project-level source data. */
export async function recordLatestShare(config: WorkbookConfig, kitProjectId: string, input: { label: string; url: string; date: string; milestone?: string | null }): Promise<void> {
  if (config.layout !== 'rf-production-v1') return
  const bound = await searchRowMetadata(config.spreadsheetId, kitProjectId, config.sheetId)
  if (!bound) return
  const values: PlainValue[] = [input.label, input.url, parseDateToSerial(input.date), input.milestone || '']
  const columns = [16, 17, 18, 22]
  const requests = values.map((value, i) => ({ updateCells: {
    start: { sheetId: config.sheetId, rowIndex: bound.rowIndex, columnIndex: columns[i] },
    rows: [{ values: [{ userEnteredValue: userValue(value) }] }], fields: 'userEnteredValue',
  } }))
  await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, { requests })
}

/** Producer-confirmed progression. The shared milestone becomes Client Review,
 * earlier rows become Complete, and the next row is promoted to In Progress. */
export async function advanceWorkbackForShare(config: WorkbookConfig, kitProjectId: string, projectNumber: string, milestone: string, actor: string): Promise<{ nextMilestone: string | null }> {
  if (config.workbackSheetId == null) return { nextMilestone: null }
  const data = await getGridData(config, { startRowIndex: config.headerRow, startColumnIndex: 0, endColumnIndex: 12 }, 'formattedValue,effectiveValue', config.workbackSheetId)
  const rows = data.map((r, i) => ({ rowIndex: config.headerRow + i, values: r.values || [] }))
    .filter((r) => normalizeCell(r.values[0]).display.trim() === projectNumber)
    .sort((a, b) => Number(normalizeCell(a.values[10]).display || 0) - Number(normalizeCell(b.values[10]).display || 0))
  const at = rows.findIndex((r) => normalizeCell(r.values[1]).display.trim() === milestone)
  if (at < 0) throw new Error(`Milestone not found: ${milestone}`)
  const next = rows[at + 1]
  const requests: unknown[] = []
  rows.forEach((r, i) => {
    if (i > at + 1) return
    const status = i < at ? 'Complete' : i === at ? 'Client Review' : 'In Progress'
    const percent = i < at ? 1 : 0
    requests.push({ updateCells: { start: { sheetId: config.workbackSheetId!, rowIndex: r.rowIndex, columnIndex: 6 }, rows: [{ values: [
      { userEnteredValue: { stringValue: status } }, { userEnteredValue: { numberValue: percent } },
    ] }], fields: 'userEnteredValue' } })
  })
  const bound = await searchRowMetadata(config.spreadsheetId, kitProjectId, config.sheetId)
  if (bound) {
    const nextName = next ? normalizeCell(next.values[1]).display : 'Final Delivery complete'
    const nextDate = next?.values[4]?.effectiveValue?.numberValue
    requests.push({ updateCells: { start: { sheetId: config.sheetId, rowIndex: bound.rowIndex, columnIndex: 8 }, rows: [{ values: [
      { userEnteredValue: { stringValue: nextName } }, { userEnteredValue: nextDate == null ? { stringValue: '' } : { numberValue: nextDate } },
    ] }], fields: 'userEnteredValue' } })
  }
  await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, { requests })
  if (config.statusLogSheetId != null) {
    await appendRows(config, config.statusLogSheetId, 4, [[projectNumber, parseDateToSerial(new Date().toISOString().slice(0, 10)), `${milestone} shared; workback advanced`, actor]])
  }
  return { nextMilestone: next ? normalizeCell(next.values[1]).display : null }
}

/** Keep every normalized child row attached when a project's human-facing ID
 * changes through Kit. Only the Project ID key moves; producer-entered values,
 * provider URLs, labels, milestone states, specs and notes remain untouched. */
export async function renameNormalizedProjectRecords(
  config: WorkbookConfig,
  oldProjectNumber: string | undefined,
  newProjectNumber: string | undefined,
): Promise<void> {
  const oldId = oldProjectNumber?.trim()
  const newId = newProjectNumber?.trim()
  if (
    config.layout !== 'rf-production-v1' ||
    !oldId || !newId || oldId === newId
  ) return
  const sheets = [
    config.linksSheetId == null ? null : { sheetId: config.linksSheetId, firstDataRowIndex: config.linksHeaderRow ?? config.headerRow },
    config.specsSheetId == null ? null : { sheetId: config.specsSheetId, firstDataRowIndex: config.headerRow },
    config.workbackSheetId == null ? null : { sheetId: config.workbackSheetId, firstDataRowIndex: config.headerRow },
    config.assignmentsSheetId == null ? null : { sheetId: config.assignmentsSheetId, firstDataRowIndex: config.headerRow },
    config.deliverablesSheetId == null ? null : { sheetId: config.deliverablesSheetId, firstDataRowIndex: config.headerRow },
    config.statusLogSheetId == null ? null : { sheetId: config.statusLogSheetId, firstDataRowIndex: config.headerRow },
  ].filter((sheet): sheet is { sheetId: number; firstDataRowIndex: number } => sheet != null)

  const scans = await Promise.all(sheets.map(async ({ sheetId, firstDataRowIndex }) => {
    const rows = await getGridData(
      config,
      { startRowIndex: firstDataRowIndex, startColumnIndex: 0, endColumnIndex: 1 },
      'formattedValue,effectiveValue',
      sheetId,
    )
    return rows.map((row, offset) => ({
      sheetId,
      rowIndex: firstDataRowIndex + offset,
      projectNumber: normalizeCell(row.values?.[0]).display.trim(),
    })).filter((row) => row.projectNumber === oldId || row.projectNumber === newId)
  }))

  const flat = scans.flat()
  const oldRows = flat.filter((row) => row.projectNumber === oldId)
  if (oldRows.length === 0) return // idempotent retry after an already-complete rename

  // Never merge one project's normalized records into another project's key.
  // A fully atomic prior run has no old rows; seeing BOTH keys means the
  // workbook is ambiguous and needs a human decision.
  if (flat.some((row) => row.projectNumber === newId)) {
    throw new Error(`normalized project id collision: ${newId}`)
  }

  const requests = oldRows.map((row) => ({ updateCells: {
    rows: [{ values: [{ userEnteredValue: { stringValue: newId } }] }],
    fields: 'userEnteredValue',
    start: { sheetId: row.sheetId, rowIndex: row.rowIndex, columnIndex: 0 },
  } }))
  await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, { requests })
}

/** Backward-compatible narrow name retained for older callers/tests. */
export const renameProjectLinks = renameNormalizedProjectRecords

// ─── Narrow single-column read / single-cell write (operator repair only) ─────

export interface ColumnCell {
  /** 0-based grid row index. */
  rowIndex: number
  /** The cell's display/plain value (formattedValue → effectiveValue string). */
  value: string
  /** The cell's hyperlink target (explicit or =HYPERLINK), else null. */
  hyperlink: string | null
}

/**
 * Read a single Master Project List column (data rows only, below the header
 * row) from the CONFIGURED sheet. Used by the operator Frame.io URL repair — it
 * inspects ONLY the Frame.io column and touches nothing else, and reuses the
 * existing service-account auth.
 *
 * Targets `config.sheetId` deterministically via a `getByDataFilter` GridRange
 * keyed by the numeric sheet id — NOT an unqualified A1 range like `R4:R`, which
 * resolves to the first *visible* tab and could read a different sheet than the
 * one `writeCellValue` writes to (`config.sheetId`). The returned sheet is then
 * re-selected by `properties.sheetId` and the read fails closed if the
 * configured sheet is absent, so a read/write tab mismatch is impossible.
 */
export async function readColumn(config: WorkbookConfig, header: string): Promise<ColumnCell[]> {
  if (config.layout === 'rf-production-v1' && (header === 'Frame.io' || header === 'Dropbox')) {
    const rows = await readRfLinkRows(config)
    return rows
      .filter((row) => normalizeLinkType(row.type) === header)
      .map((row) => ({ rowIndex: row.rowIndex, value: row.url, hyperlink: row.url || null }))
  }
  const columnIndex = headerToA1Column(header, config.layout || 'legacy').charCodeAt(0) - 'A'.charCodeAt(0)
  const firstDataRowIndex = config.headerRow // 0-based grid index of the first data row
  const rowData = await getGridData(
    config,
    { startRowIndex: firstDataRowIndex, startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 },
    'formattedValue,effectiveValue,userEnteredValue,hyperlink',
  )
  const out: ColumnCell[] = []
  rowData.forEach((rd, i) => {
    const norm = normalizeCell(rd?.values?.[0])
    out.push({ rowIndex: firstDataRowIndex + i, value: norm.display, hyperlink: norm.hyperlink })
  })
  return out
}

/**
 * Write a single plain-string cell in one Master Project List column at a grid
 * row index. `fields:'userEnteredValue'` preserves the cell's existing format +
 * data validation (never touches formatting or neighbouring cells). Used by the
 * Frame.io URL repair.
 */
export async function writeCellValue(
  config: WorkbookConfig,
  rowIndex: number,
  header: string,
  value: string,
): Promise<void> {
  const normalizedLink = config.layout === 'rf-production-v1' && (header === 'Frame.io' || header === 'Dropbox')
  const columnIndex = normalizedLink
    ? 3
    : headerToA1Column(header, config.layout || 'legacy').charCodeAt(0) - 'A'.charCodeAt(0)
  const sheetId = normalizedLink ? config.linksSheetId : config.sheetId
  if (sheetId == null) throw new Error(`writeCellValue: Links sheet is not configured for ${header}`)
  await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, {
    requests: [{
      updateCells: {
        rows: [{ values: [{ userEnteredValue: { stringValue: value } }] }],
        fields: 'userEnteredValue',
        start: { sheetId, rowIndex, columnIndex },
      },
    }],
  })
}
