/**
 * Sheets client tests via an injected transport (no network, no creds).
 *
 * Run: npx tsx --test src/lib/project-control/sheets.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createBoundRow, searchRowMetadata, readColumn, __setSheetsTransportForTests } from './sheets'
import { kitOwnedCreationCells, parseDateToSerial } from './render'
import type { SheetCell } from './render'
import type { WorkbookConfig } from './types'

const CONFIG: WorkbookConfig = {
  spreadsheetId: 'sid',
  sheetId: 0,
  headerRow: 3,
  templateChannelId: 'C0',
}

afterEach(() => __setSheetsTransportForTests(null))

interface UpdateCellsReq {
  updateCells: {
    rows: Array<{ values: Array<{ userEnteredValue?: { numberValue?: number; stringValue?: string } }> }>
    fields: string
    start: { columnIndex: number }
  }
}

/** A fake Google backend that models developer-metadata search-before-write. */
function fakeBackend() {
  const state = { metadataExists: false, batchUpdates: 0, lastRequests: [] as UpdateCellsReq[] }
  const transport = async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
    if (url.includes('developerMetadata:search')) {
      return {
        matchedDeveloperMetadata: state.metadataExists
          ? [{ developerMetadata: { metadataId: 99, location: { dimensionRange: { startIndex: 5 } } } }]
          : [],
      } as T
    }
    if (url.includes('/values/')) return { values: [[]] } as T // empty column A
    if (url.includes(':batchUpdate')) {
      state.batchUpdates++
      state.lastRequests = (body as { requests: UpdateCellsReq[] }).requests
      state.metadataExists = true
      return { replies: [{ createDeveloperMetadata: { developerMetadata: { metadataId: 99 } } }] } as T
    }
    throw new Error(`unexpected url ${url}`)
  }
  return { state, transport }
}

describe('createBoundRow idempotency', () => {
  it('does not create a second row when metadata already exists (retry after ambiguous write)', async () => {
    const be = fakeBackend()
    __setSheetsTransportForTests(be.transport)
    const owned = kitOwnedCreationCells({ projectNumber: '2601', clientName: 'Nike', projectName: 'S' })

    const first = await createBoundRow(CONFIG, 'proj-1', owned)
    assert.equal(first.alreadyBound, false)
    assert.equal(be.state.batchUpdates, 1)

    const second = await createBoundRow(CONFIG, 'proj-1', owned)
    assert.equal(second.alreadyBound, true)
    assert.equal(second.metadataId, 99)
    assert.equal(be.state.batchUpdates, 1) // NO second write
  })
})

describe('createBoundRow date + margin safety', () => {
  it('writes dates as serial numbers with a DATE format, never text; never writes margins', async () => {
    const be = fakeBackend()
    __setSheetsTransportForTests(be.transport)
    const owned = kitOwnedCreationCells({
      projectNumber: '2601', clientName: 'Nike', projectName: 'S', startDate: '2026-07-04',
    })
    await createBoundRow(CONFIG, 'proj-2', owned)

    const cellReqs = be.state.lastRequests.filter((r) => r.updateCells)
    const serial = parseDateToSerial('2026-07-04')
    const dateReq = cellReqs.find(
      (r) => r.updateCells.rows[0].values[0].userEnteredValue?.numberValue === serial,
    )
    assert.ok(dateReq, 'a date cell is written as a serial number')
    assert.match(dateReq!.updateCells.fields, /numberFormat/)
    // No cell writes the date as literal text.
    const asText = cellReqs.some(
      (r) => r.updateCells.rows[0].values[0].userEnteredValue?.stringValue === '2026-07-04',
    )
    assert.equal(asText, false)
    // Column U (Current Margin, index 20) / V (index 21) are never targeted.
    const cols = cellReqs.map((r) => r.updateCells.start.columnIndex)
    assert.ok(!cols.includes(20) && !cols.includes(21))
  })
})

describe('searchRowMetadata', () => {
  it('returns null when no metadata matches', async () => {
    __setSheetsTransportForTests(async <T>() => ({ matchedDeveloperMetadata: [] }) as T)
    assert.equal(await searchRowMetadata('sid', 'nope'), null)
  })
})

describe('readColumn — targets the CONFIGURED sheetId (not tab order)', () => {
  const cell = (v: string): SheetCell => (v ? { formattedValue: v, effectiveValue: { stringValue: v } } : {})

  interface GridRangeReq {
    dataFilters: Array<{ gridRange: { sheetId: number; startRowIndex: number; startColumnIndex: number; endColumnIndex: number } }>
    includeGridData?: boolean
  }

  /**
   * A workbook with TWO tabs: sheet 0 is the first/visible tab (an unqualified
   * A1 range like R4:R would read THIS one) and carries a decoy value; sheet 42
   * is the configured target. The transport returns ONLY the sheet whose id the
   * caller filtered on — so a correct read of sheet 42 can never surface sheet
   * 0's decoy.
   */
  function multiSheetBackend() {
    const calls: Array<{ method: string; url: string; body?: unknown }> = []
    const rowsBySheet: Record<number, SheetCell[][]> = {
      0: [[cell('https://app.frame.io/projects/WRONG-TAB')]],
      42: [
        [cell('https://app.frame.io/projects/RIGHT-1')],
        [cell('')],
        [cell('https://app.frame.io/projects/RIGHT-2')],
      ],
    }
    const transport = async <T>(method: string, url: string, body?: unknown): Promise<T> => {
      calls.push({ method, url, body })
      if (url.includes(':getByDataFilter')) {
        const gr = (body as GridRangeReq).dataFilters[0].gridRange
        const rowData = (rowsBySheet[gr.sheetId] || []).map((values) => ({ values }))
        return { sheets: [{ properties: { sheetId: gr.sheetId }, data: [{ rowData }] }] } as T
      }
      throw new Error(`unexpected url ${url}`)
    }
    return { calls, transport }
  }

  it('reads the configured tab via getByDataFilter keyed by numeric sheetId', async () => {
    const be = multiSheetBackend()
    __setSheetsTransportForTests(be.transport)
    const config: WorkbookConfig = { spreadsheetId: 'sid', sheetId: 42, headerRow: 3, templateChannelId: 'C0' }

    const cells = await readColumn(config, 'Frame.io')

    // Values come from sheet 42, NOT the first/visible sheet 0.
    assert.deepEqual(cells.map((c) => c.value), [
      'https://app.frame.io/projects/RIGHT-1',
      '',
      'https://app.frame.io/projects/RIGHT-2',
    ])
    assert.ok(!cells.some((c) => c.value.includes('WRONG-TAB')), 'never reads the first-visible tab')

    // Row indices are 0-based grid indices starting at the first data row (headerRow).
    assert.deepEqual(cells.map((c) => c.rowIndex), [3, 4, 5])

    // Exactly one request: a getByDataFilter POST keyed by the numeric sheetId,
    // targeting the Frame.io column (R = index 17). No unqualified A1 GET.
    assert.equal(be.calls.length, 1)
    const [call] = be.calls
    assert.equal(call.method, 'POST')
    assert.match(call.url, /:getByDataFilter/)
    assert.ok(!/ranges=/.test(call.url), 'does not use an unqualified A1 range')
    const gr = (call.body as GridRangeReq).dataFilters[0].gridRange
    assert.equal(gr.sheetId, 42)
    assert.equal(gr.startRowIndex, 3)
    assert.equal(gr.startColumnIndex, 17)
    assert.equal(gr.endColumnIndex, 18)
  })

  it('fails closed when the configured sheet is not returned (never reads a fallback tab)', async () => {
    // Transport returns some OTHER sheet id → the read must throw, not silently
    // read the wrong tab.
    __setSheetsTransportForTests(async <T>() =>
      ({ sheets: [{ properties: { sheetId: 999 }, data: [{ rowData: [[{ formattedValue: 'x' }]] }] }] }) as T)
    const config: WorkbookConfig = { spreadsheetId: 'sid', sheetId: 42, headerRow: 3, templateChannelId: 'C0' }
    await assert.rejects(() => readColumn(config, 'Frame.io'), /sheet 42 not found/)
  })
})
