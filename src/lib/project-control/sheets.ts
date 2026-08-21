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
} from './render'

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

/** Test seam: swap the HTTP transport for a fake. Pass null to restore. */
export function __setSheetsTransportForTests(t: Transport | null): void {
  transport = t || httpTransport
}

function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  return transport<T>(method, url, body)
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
interface BatchUpdateResponse {
  replies?: Array<{ createDeveloperMetadata?: { developerMetadata?: { metadataId?: number } } }>
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

function normalizeLinkType(value: string): 'Frame.io' | 'Dropbox' | null {
  const v = value.trim().toLowerCase()
  if (v === 'frame.io' || v === 'frameio') return 'Frame.io'
  if (v === 'dropbox' || v.startsWith('dropbox ')) return 'Dropbox'
  return null
}

async function readRfLinkRows(config: WorkbookConfig): Promise<Array<{ rowIndex: number; projectNumber: string; type: string; url: string }>> {
  if (config.linksSheetId == null) return []
  const firstDataRowIndex = config.linksHeaderRow ?? config.headerRow
  const data = await getGridData(
    config,
    { startRowIndex: firstDataRowIndex, startColumnIndex: 0, endColumnIndex: 3 },
    'formattedValue,effectiveValue,userEnteredValue,hyperlink',
    config.linksSheetId,
  )
  return data.map((rd, i) => ({
    rowIndex: firstDataRowIndex + i,
    projectNumber: normalizeCell(rd.values?.[0]).display.trim(),
    type: normalizeCell(rd.values?.[1]).display.trim(),
    url: normalizeCell(rd.values?.[2]).hyperlink || normalizeCell(rd.values?.[2]).display.trim(),
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
  put('Project Name', 3)
  put('Quick Status', 4)
  put('Status', 5)
  put('Next Share', 6)
  put('End Date', 7)
  put('Creative Director', 8)
  put('Producer', 9)
  // Prefer the explicitly named Client Contact column; fall back to Contact for
  // migrated rows where the newer field is blank.
  out[MASTER_HEADERS.indexOf('Client Contact')] = physical[10] || physical[2] || {}
  if (!projectNumberFromCell(out[MASTER_HEADERS.indexOf('Client Contact')])) {
    out[MASTER_HEADERS.indexOf('Client Contact')] = physical[2] || {}
  }
  put('Start Date', 11)

  const projectNumber = projectNumberFromCell(physical[0])
  if (projectNumber && config.linksSheetId != null) {
    const links = await readRfLinkRows(config)
    for (const link of links) {
      if (link.projectNumber !== projectNumber) continue
      const type = normalizeLinkType(link.type)
      if (type && link.url) out[MASTER_HEADERS.indexOf(type)] = textCell(link.url)
    }
  }
  return out
}

/**
 * Locate the next writable row (0-based grid index) ON THE CONFIGURED SHEET:
 * the first fully-empty row at/after the data region, using column A (Project
 * Number) as the occupancy signal. Deterministic and non-destructive — never a
 * blind full-width append. Uses the same sheetId-keyed read as every other row
 * read, so the creation write-row is chosen from `config.sheetId`, never the
 * first visible tab (which would place the row against the wrong tab's
 * occupancy and could overwrite a real row on the configured sheet).
 */
async function findNextEmptyRowIndex(config: WorkbookConfig): Promise<number> {
  const firstDataRowIndex = config.headerRow // 0-based grid index of the first data row
  const rowData = await getGridData(
    config,
    { startRowIndex: firstDataRowIndex, startColumnIndex: 0, endColumnIndex: 1 },
    'formattedValue,effectiveValue',
  )
  let offset = rowData.findIndex((rd) => normalizeCell(rd?.values?.[0]).display.trim() === '')
  if (offset < 0) offset = rowData.length
  return firstDataRowIndex + offset
}

export interface CreateBoundRowResult {
  metadataId: number
  rowIndex: number
  alreadyBound: boolean
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
  const colIndex = (header: string) => headerToA1Column(header, config.layout || 'legacy').charCodeAt(0) - 'A'.charCodeAt(0)
  return ownedCells.map((cell) => {
    const start = { sheetId: config.sheetId, rowIndex, columnIndex: colIndex(cell.header) }
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

  const requests: unknown[] = buildCellRequests(config, rowIndex, ownedCells)
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
  ].filter((x): x is { type: 'Frame.io' | 'Dropbox'; url: string } => Boolean(x.url))
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
          start: { sheetId: config.linksSheetId, rowIndex: existing.rowIndex, columnIndex: 2 },
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
          { userEnteredValue: { stringValue: link.url } },
        ] }],
        fields: 'userEnteredValue',
        start: { sheetId: config.linksSheetId, rowIndex, columnIndex: 0 },
      },
    })
  }
  await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, { requests })
}

/** Keep normalized Links rows attached when a project's human-facing ID is
 * changed through Kit. Provider URLs and link labels are left untouched. */
export async function renameProjectLinks(
  config: WorkbookConfig,
  oldProjectNumber: string | undefined,
  newProjectNumber: string | undefined,
): Promise<void> {
  const oldId = oldProjectNumber?.trim()
  const newId = newProjectNumber?.trim()
  if (
    config.layout !== 'rf-production-v1' || config.linksSheetId == null ||
    !oldId || !newId || oldId === newId
  ) return
  const rows = await readRfLinkRows(config)
  const matching = rows.filter((r) => r.projectNumber === oldId)
  if (matching.length === 0) return
  const requests = matching.map((row) => ({
    updateCells: {
      rows: [{ values: [{ userEnteredValue: { stringValue: newId } }] }],
      fields: 'userEnteredValue',
      start: { sheetId: config.linksSheetId!, rowIndex: row.rowIndex, columnIndex: 0 },
    },
  }))
  await api<BatchUpdateResponse>('POST', `${SHEETS_BASE}/${config.spreadsheetId}:batchUpdate`, { requests })
}

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
    ? 2
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
