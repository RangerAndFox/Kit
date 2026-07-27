/**
 * Sheets client tests via an injected transport (no network, no creds).
 *
 * Run: npx tsx --test src/lib/project-control/sheets.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createBoundRow, searchRowMetadata, readColumn, readRow, __setSheetsTransportForTests } from './sheets'
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

/** A fake Google backend that models developer-metadata search-before-write.
 *  CONFIG.sheetId is 0, so the written metadata is located on sheet 0 and the
 *  empty-row scan (now a getByDataFilter on sheet 0) returns an empty column A. */
function fakeBackend() {
  const state = { metadataExists: false, batchUpdates: 0, lastRequests: [] as UpdateCellsReq[] }
  const transport = async <T>(_method: string, url: string, _body?: unknown): Promise<T> => {
    if (url.includes('developerMetadata:search')) {
      return {
        matchedDeveloperMetadata: state.metadataExists
          ? [{ developerMetadata: { metadataId: 99, location: { dimensionRange: { startIndex: 5, sheetId: 0 } } } }]
          : [],
      } as T
    }
    // findNextEmptyRowIndex now reads column A via getByDataFilter on config.sheetId.
    if (url.includes(':getByDataFilter')) {
      return { sheets: [{ properties: { sheetId: 0 }, data: [{ rowData: [] }] }] } as T // empty column A
    }
    if (url.includes(':batchUpdate')) {
      state.batchUpdates++
      state.lastRequests = (_body as { requests: UpdateCellsReq[] }).requests
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

describe('searchRowMetadata — sheet-aware ownership', () => {
  it('returns null when no metadata matches anywhere', async () => {
    __setSheetsTransportForTests(async <T>() => ({ matchedDeveloperMetadata: [] }) as T)
    assert.equal(await searchRowMetadata('sid', 'nope', 42), null)
  })

  it('accepts a match on the CONFIGURED sheet and returns its sheetId', async () => {
    __setSheetsTransportForTests(async <T>() =>
      ({ matchedDeveloperMetadata: [{ developerMetadata: { metadataId: 7, location: { dimensionRange: { startIndex: 11, sheetId: 42 } } } }] }) as T)
    const m = await searchRowMetadata('sid', 'proj', 42)
    assert.deepEqual(m, { metadataId: 7, rowIndex: 11, sheetId: 42 })
  })

  it('picks the configured-sheet match even when a wrong-sheet match is listed first', async () => {
    __setSheetsTransportForTests(async <T>() =>
      ({ matchedDeveloperMetadata: [
        { developerMetadata: { metadataId: 1, location: { dimensionRange: { startIndex: 5, sheetId: 0 } } } },
        { developerMetadata: { metadataId: 2, location: { dimensionRange: { startIndex: 11, sheetId: 42 } } } },
      ] }) as T)
    const m = await searchRowMetadata('sid', 'proj', 42)
    assert.deepEqual(m, { metadataId: 2, rowIndex: 11, sheetId: 42 })
  })

  it('THROWS (fail closed) when the same project id only matches on ANOTHER sheet', async () => {
    __setSheetsTransportForTests(async <T>() =>
      ({ matchedDeveloperMetadata: [{ developerMetadata: { metadataId: 1, location: { dimensionRange: { startIndex: 5, sheetId: 0 } } } }] }) as T)
    await assert.rejects(() => searchRowMetadata('sid', 'proj', 42), /not the configured sheet 42/)
  })
})

describe('readRow — targets the CONFIGURED sheetId (not tab order)', () => {
  interface GridRangeReq {
    dataFilters: Array<{ gridRange: { sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number } }>
  }
  // A:Y = 25 columns; put a marker in Client (col B, index 1) per sheet.
  const rowFor = (client: string): SheetCell[] => {
    const cells: SheetCell[] = Array.from({ length: 25 }, () => ({}))
    cells[1] = { formattedValue: client, effectiveValue: { stringValue: client } }
    return cells
  }
  function backend() {
    const calls: Array<{ url: string; body?: unknown }> = []
    const rowsBySheet: Record<number, SheetCell[]> = {
      0: rowFor('WRONG-TAB-CLIENT'),
      42: rowFor('RIGHT-TAB-CLIENT'),
    }
    const transport = async <T>(_m: string, url: string, body?: unknown): Promise<T> => {
      calls.push({ url, body })
      if (url.includes(':getByDataFilter')) {
        const gr = (body as GridRangeReq).dataFilters[0].gridRange
        const values = rowsBySheet[gr.sheetId]
        const rowData = values ? [{ values }] : []
        return { sheets: [{ properties: { sheetId: gr.sheetId }, data: [{ rowData }] }] } as T
      }
      throw new Error(`unexpected url ${url}`)
    }
    return { calls, transport }
  }

  it('reads row A:Y from the configured tab even when another tab appears first', async () => {
    const be = backend()
    __setSheetsTransportForTests(be.transport)
    const config: WorkbookConfig = { spreadsheetId: 'sid', sheetId: 42, headerRow: 3, templateChannelId: 'C0' }

    const cells = await readRow(config, 5)
    assert.equal(cells.length, 25) // full A:Y
    assert.equal(cells[1].formattedValue, 'RIGHT-TAB-CLIENT') // sheet 42, never sheet 0
    assert.ok(!cells.some((c) => c.formattedValue === 'WRONG-TAB-CLIENT'))

    // Keyed by numeric sheetId for exactly the requested row, columns A:Y.
    assert.equal(be.calls.length, 1)
    assert.match(be.calls[0].url, /:getByDataFilter/)
    assert.ok(!/ranges=/.test(be.calls[0].url), 'no unqualified A1 range')
    const gr = (be.calls[0].body as GridRangeReq).dataFilters[0].gridRange
    assert.equal(gr.sheetId, 42)
    assert.equal(gr.startRowIndex, 5)
    assert.equal(gr.endRowIndex, 6)
    assert.equal(gr.startColumnIndex, 0)
    assert.equal(gr.endColumnIndex, 25)
  })

  it('fails closed when the configured sheet is absent from the response', async () => {
    __setSheetsTransportForTests(async <T>() =>
      ({ sheets: [{ properties: { sheetId: 999 }, data: [{ rowData: [{ values: [{ formattedValue: 'x' }] }] }] }] }) as T)
    const config: WorkbookConfig = { spreadsheetId: 'sid', sheetId: 42, headerRow: 3, templateChannelId: 'C0' }
    await assert.rejects(() => readRow(config, 5), /configured sheet 42 not found/)
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
