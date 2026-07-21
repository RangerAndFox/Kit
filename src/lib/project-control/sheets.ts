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
import { MASTER_HEADERS, type SheetCell, type OwnedCell } from './render'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ')
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files'
const A1_LAST_COLUMN = 'Y' // A:Y
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
interface DevMetadata { metadataId?: number; location?: { dimensionRange?: { startIndex?: number } } }
interface DevMetadataSearchResponse { matchedDeveloperMetadata?: Array<{ developerMetadata?: DevMetadata }> }
interface SpreadsheetGetResponse {
  sheets?: Array<{ data?: Array<{ rowData?: Array<{ values?: SheetCell[] }> }> }>
}
interface ValuesGetResponse { values?: string[][] }
interface BatchUpdateResponse {
  replies?: Array<{ createDeveloperMetadata?: { developerMetadata?: { metadataId?: number } } }>
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
}

/**
 * Find the row bound to a project via developer metadata. Returns null when no
 * metadata record exists (used both before writing and after an ambiguous
 * response, so a retry never double-creates a row).
 */
export async function searchRowMetadata(
  spreadsheetId: string,
  kitProjectId: string,
): Promise<RowMetadataMatch | null> {
  const data = await api<DevMetadataSearchResponse>(
    'POST',
    `${SHEETS_BASE}/${spreadsheetId}/developerMetadata:search`,
    { dataFilters: [{ developerMetadataLookup: { metadataKey: KIT_PROJECT_ID_METADATA_KEY, metadataValue: kitProjectId } }] },
  )
  const matched = data.matchedDeveloperMetadata || []
  if (matched.length === 0) return null
  const dm = matched[0].developerMetadata
  const start = dm?.location?.dimensionRange?.startIndex
  if (dm?.metadataId == null || start == null) return null
  return { metadataId: dm.metadataId, rowIndex: start }
}

/** Read one row's cells (A:Y) with the metadata needed to normalize them. */
export async function readRow(config: WorkbookConfig, rowIndex: number): Promise<SheetCell[]> {
  const a1Row = rowIndex + 1 // grid 0-based -> A1 1-based
  const fields = encodeURIComponent(
    'sheets(data(rowData(values(formattedValue,effectiveValue,userEnteredValue,hyperlink,effectiveFormat.numberFormat.type))))',
  )
  const range = encodeURIComponent(`A${a1Row}:${A1_LAST_COLUMN}${a1Row}`)
  const data = await api<SpreadsheetGetResponse>(
    'GET',
    `${SHEETS_BASE}/${config.spreadsheetId}?ranges=${range}&includeGridData=true&fields=${fields}`,
  )
  const values = data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || []
  const cells: SheetCell[] = []
  for (let i = 0; i < MASTER_HEADERS.length; i++) cells.push((values[i] as SheetCell) || {})
  return cells
}

/**
 * Locate the next writable row (0-based grid index): the first fully-empty row
 * at/after the data region, using column A (Project Number) as the occupancy
 * signal. Deterministic and non-destructive — never a blind full-width append.
 */
async function findNextEmptyRowIndex(config: WorkbookConfig): Promise<number> {
  const firstDataRow = config.headerRow + 1 // A1
  const range = encodeURIComponent(`A${firstDataRow}:A`)
  const data = await api<ValuesGetResponse>(
    'GET',
    `${SHEETS_BASE}/${config.spreadsheetId}/values/${range}?majorDimension=COLUMNS`,
  )
  const colA = data.values?.[0] || []
  let offset = colA.findIndex((v) => v == null || String(v).trim() === '')
  if (offset < 0) offset = colA.length
  return firstDataRow - 1 /* to 0-based */ + offset
}

export interface CreateBoundRowResult {
  metadataId: number
  rowIndex: number
  alreadyBound: boolean
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
  const existing = await searchRowMetadata(config.spreadsheetId, kitProjectId)
  if (existing) return { ...existing, alreadyBound: true }

  const rowIndex = await findNextEmptyRowIndex(config)
  const colIndex = (col: string) => col.charCodeAt(0) - 'A'.charCodeAt(0)

  // Date cells: write the serial number AND explicitly set a DATE number format
  // in the same atomic request, so the value is a real date (never locale text).
  // String cells: write value only (fields:'userEnteredValue' preserves the
  // cell's existing format + validation).
  const requests: unknown[] = ownedCells.map((cell) => {
    const start = { sheetId: config.sheetId, rowIndex, columnIndex: colIndex(cell.column) }
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
