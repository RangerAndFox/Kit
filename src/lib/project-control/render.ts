/**
 * Project Control — pure rendering + hashing core.
 *
 * No I/O. Everything here is deterministic so it can be unit-tested without
 * Google/Slack/Supabase. The sync path feeds normalized Sheet cells in and gets
 * a Canvas markdown body + a stable source hash out.
 *
 * The Master Project List is authoritative (spreadsheet
 * 1mW2ywjhSlgT13RxjMPKbSC1kby4feh6pIqiii0Pf-0w, sheet 1050051919, header row 3,
 * data columns A:Y). Kit writes only a small owned subset at creation and never
 * touches the margin formula columns.
 */

import { createHash } from 'node:crypto'

// A:Y, in column order. Column letter = A + index.
export const MASTER_HEADERS = [
  'Project Number', // A
  'Client', // B
  'Client Contact', // C
  'Project Name', // D
  'Quick Status', // E
  'Status', // F
  'Start Date', // G
  'End Date', // H
  'Last Share', // I
  'Next Share', // J
  'Creative Director', // K
  'Producer', // L
  'VO', // M
  'Music', // N
  'Client Brief', // O
  'Script', // P
  'Assets + Figma Files', // Q
  'Frame.io', // R
  'Dropbox', // S
  'Budget Link', // T
  'Current Margin', // U
  'Projected Margin', // V
  'Deliverables', // W
  'Delivery Specs', // X
  'Delivery Link', // Y
] as const

export type MasterHeader = (typeof MASTER_HEADERS)[number]

// Formula/computed columns Kit must never write.
export const NEVER_WRITE_HEADERS: MasterHeader[] = ['Current Margin', 'Projected Margin']

/** Minimal shape of a Google Sheets CellData (fields we request). */
export interface SheetCell {
  formattedValue?: string
  effectiveValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean }
  userEnteredValue?: { formulaValue?: string; stringValue?: string; numberValue?: number }
  hyperlink?: string
  effectiveFormat?: { numberFormat?: { type?: string } }
}

export interface NormalizedCell {
  /** What a human sees (formattedValue). */
  display: string
  /** Underlying value. */
  value: string | number | boolean | null
  /** Hyperlink target (explicit cell hyperlink or =HYPERLINK formula), else null. */
  hyperlink: string | null
  /** ISO date (YYYY-MM-DD) when the cell is date-formatted, else null. */
  iso: string | null
}

export type NormalizedRow = Record<string, NormalizedCell>

/** Column letter for a Master Project List header (A:Y). */
export function headerToA1Column(header: string): string {
  const idx = (MASTER_HEADERS as readonly string[]).indexOf(header)
  if (idx < 0) throw new Error(`Unknown Master Project List header: ${header}`)
  return String.fromCharCode('A'.charCodeAt(0) + idx)
}

const HYPERLINK_FORMULA = /=HYPERLINK\(\s*"([^"]+)"/i

// Sheets serial date epoch is 1899-12-30.
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30)

function serialToISO(serial: number): string {
  const ms = SHEETS_EPOCH_MS + Math.round(serial) * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

export function normalizeCell(cell: SheetCell | undefined | null): NormalizedCell {
  const c = cell || {}
  const ev = c.effectiveValue || {}
  const value: string | number | boolean | null =
    ev.stringValue ?? ev.numberValue ?? ev.boolValue ?? null

  let hyperlink: string | null = c.hyperlink ?? null
  if (!hyperlink && c.userEnteredValue?.formulaValue) {
    const m = c.userEnteredValue.formulaValue.match(HYPERLINK_FORMULA)
    if (m) hyperlink = m[1]
  }

  let iso: string | null = null
  const nf = c.effectiveFormat?.numberFormat?.type || ''
  if ((nf === 'DATE' || nf === 'DATE_TIME') && typeof ev.numberValue === 'number') {
    iso = serialToISO(ev.numberValue)
  }

  const display = c.formattedValue ?? (value != null ? String(value) : '')
  return { display, value, hyperlink, iso }
}

/** Map a parallel array of cells (A:Y order) onto their headers. */
export function normalizeRow(headers: readonly string[], cells: Array<SheetCell | undefined>): NormalizedRow {
  const row: NormalizedRow = {}
  headers.forEach((h, i) => {
    row[h] = normalizeCell(cells[i])
  })
  return row
}

/**
 * Stable hash of the authoritative row. Includes hyperlink targets and ISO date
 * forms so a cell displayed as "link" (identical text, different target) still
 * registers as a change. Order is fixed by MASTER_HEADERS.
 */
export function sourceRowHash(row: NormalizedRow): string {
  const material = MASTER_HEADERS.map((h) => {
    const c = row[h] || { display: '', value: null, hyperlink: null, iso: null }
    return [h, c.display, c.value === null ? null : String(c.value), c.hyperlink, c.iso]
  })
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

// ─── Kit-owned creation fields (Sheet writes) ────────────────────────────────

export interface CreationSubmission {
  projectNumber?: string
  clientName?: string
  projectName?: string
  initialStatus?: string
  startDate?: string
  deadline?: string
  creativeDirectorName?: string
  producerName?: string
  frameioUrl?: string
  dropboxUrl?: string
}

export interface OwnedCell {
  header: MasterHeader
  column: string
  /** 'date' cells are written as a Sheets serial number with a DATE format;
   *  'string' cells as plain text. */
  kind: 'string' | 'date'
  /** Display/source form (kept for logging + string writes). */
  value: string
  /** Sheets serial-date value, present iff kind === 'date'. */
  serial?: number
}

// Columns Kit writes as real dates, never locale-dependent text.
const DATE_HEADERS = new Set<MasterHeader>(['Start Date', 'End Date'])

/**
 * Parse an ISO `YYYY-MM-DD` (the Slack datepicker format) into a Google Sheets
 * serial date number. Returns null for absent or invalid dates (so they stay
 * blank rather than silently becoming text). Rejects impossible dates
 * (e.g. 2026-02-31) via a round-trip check.
 */
export function parseDateToSerial(input?: string): number | null {
  if (!input) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim())
  if (!m) return null
  const year = +m[1], month = +m[2], day = +m[3]
  const utc = Date.UTC(year, month - 1, day)
  const dt = new Date(utc)
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null
  }
  return Math.round((utc - SHEETS_EPOCH_MS) / 86_400_000)
}

/**
 * The Kit-owned creation columns, as concrete cell writes. Blank/missing fields
 * are omitted; invalid dates are dropped (never written as text). Margin columns
 * are never produced. This is the ONLY set Kit writes at row creation — every
 * other column stays Sheet-owned.
 */
export function kitOwnedCreationCells(sub: CreationSubmission): OwnedCell[] {
  const map: Array<[MasterHeader, string | undefined]> = [
    ['Project Number', sub.projectNumber],
    ['Client', sub.clientName],
    ['Project Name', sub.projectName],
    ['Status', sub.initialStatus],
    ['Start Date', sub.startDate],
    ['End Date', sub.deadline],
    ['Creative Director', sub.creativeDirectorName],
    ['Producer', sub.producerName],
    ['Frame.io', sub.frameioUrl],
    ['Dropbox', sub.dropboxUrl],
  ]
  const out: OwnedCell[] = []
  for (const [header, value] of map) {
    if (value == null || String(value).trim() === '') continue
    if (NEVER_WRITE_HEADERS.includes(header)) continue // defensive; never in map
    if (DATE_HEADERS.has(header)) {
      const serial = parseDateToSerial(String(value))
      if (serial == null) continue // invalid/absent date → leave blank, never text
      out.push({ header, column: headerToA1Column(header), kind: 'date', value: String(value), serial })
    } else {
      out.push({ header, column: headerToA1Column(header), kind: 'string', value: String(value) })
    }
  }
  return out
}

// ─── Deterministic Canvas render ─────────────────────────────────────────────

/** Normalize a label the same way the template fill logic does. */
function normLabel(s: string): string {
  return s
    .replace(/!\[\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*`>_~:|.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// Canvas metadata label -> authoritative Master Project List header. Only the
// unambiguous mappings are wired; ambiguous template rows (Project Type, Figma,
// Milestones) have no Sheet column and are left as the template snapshot has
// them — a deliberate non-guess (see mission field-ownership contract).
const LABEL_TO_HEADER: Record<string, MasterHeader> = {
  [normLabel('Client')]: 'Client',
  [normLabel('Contacts')]: 'Client Contact',
  [normLabel('Producer')]: 'Producer',
  [normLabel('CD')]: 'Creative Director',
  [normLabel('VO')]: 'VO',
  [normLabel('Dropbox')]: 'Dropbox',
  [normLabel('Frame.io')]: 'Frame.io',
}

function renderCellValue(cell: NormalizedCell | undefined): string {
  if (!cell) return ''
  if (cell.hyperlink) return `[${cell.display || cell.hyperlink}](${cell.hyperlink})`
  return cell.display
}

/**
 * Render the entire managed Project Control Canvas from the stored template
 * snapshot and the authoritative normalized row. Fully replaces mapped value
 * cells (not "only-empty"), so the render is deterministic and idempotent.
 */
export function renderProjectControlCanvas(templateMarkdown: string, row: NormalizedRow): string {
  const filled = templateMarkdown
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return line
      const cells = trimmed.slice(1, -1).split('|')
      if (cells.length < 2) return line
      const header = LABEL_TO_HEADER[normLabel(cells[0])]
      if (!header) return line
      const lastIdx = cells.length - 1
      cells[lastIdx] = ` ${renderCellValue(row[header])} `
      const indent = line.slice(0, line.indexOf('|'))
      return `${indent}|${cells.join('|')}|`
    })
    .join('\n')

  const spine = ['Project Number', 'Client', 'Project Name']
    .map((h) => (row[h]?.display || '').trim())
    .filter(Boolean)
    .join('_')
  if (spine) return filled.replace(/2x{2,}\s+client\s+project/i, spine)
  return filled
}
