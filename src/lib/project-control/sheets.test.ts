/**
 * Sheets client tests via an injected transport (no network, no creds).
 *
 * Run: npx tsx --test src/lib/project-control/sheets.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createBoundRow,
  searchRowMetadata,
  readColumn,
  readRow,
  updateBoundRow,
  upsertProjectLinks,
  renameProjectLinks,
  renameNormalizedProjectRecords,
  readProjectSupplement,
  seedNormalizedProjectTables,
  adoptLegacyProjectRow,
  __setSheetsTransportForTests,
} from './sheets'
import { kitOwnedCreationCells, parseDateToSerial, MASTER_HEADERS } from './render'
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

describe('createBoundRow RF Production placement safety', () => {
  it('does not overwrite a row whose Project ID is blank but another Projects cell is occupied', async () => {
    const config: WorkbookConfig = { ...CONFIG, layout: 'rf-production-v1' }
    let requestedEndColumnIndex: number | undefined
    let metadataStartIndex: number | undefined
    let expandedTableEndIndex: number | undefined

    __setSheetsTransportForTests(async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
      if (url.includes('developerMetadata:search')) return { matchedDeveloperMetadata: [] } as T
      if (url.includes(':getByDataFilter')) {
        const request = body as { dataFilters: Array<{ gridRange: { endColumnIndex: number } }> }
        requestedEndColumnIndex = request.dataFilters[0].gridRange.endColumnIndex
        const occupiedWithoutId: SheetCell[] = Array.from({ length: 15 }, () => ({}))
        occupiedWithoutId[3] = { formattedValue: 'Fabric Branding Assignment' }
        return {
          sheets: [{
            properties: { sheetId: config.sheetId },
            data: [{ rowData: [{ values: occupiedWithoutId }, { values: [] }] }],
          }],
        } as T
      }
      if (decodeURIComponent(url).includes('tables(tableId,range)')) {
        return { sheets: [{
          properties: { sheetId: config.sheetId },
          tables: [{ tableId: 'projects-table', range: {
            sheetId: config.sheetId, startRowIndex: 2, endRowIndex: 4,
            startColumnIndex: 0, endColumnIndex: 23,
          } }],
        }] } as T
      }
      if (url.includes(':batchUpdate')) {
        const requests = (body as { requests: Array<{
          createDeveloperMetadata?: { developerMetadata: { location: { dimensionRange: { startIndex: number } } } }
          updateTable?: { table: { range: { endRowIndex: number } } }
        }> }).requests
        metadataStartIndex = requests.find((request) => request.createDeveloperMetadata)
          ?.createDeveloperMetadata?.developerMetadata.location.dimensionRange.startIndex
        expandedTableEndIndex = requests.find((request) => request.updateTable)
          ?.updateTable?.table.range.endRowIndex
        return { replies: [{ createDeveloperMetadata: { developerMetadata: { metadataId: 101 } } }] } as T
      }
      throw new Error(`unexpected url ${url}`)
    })

    await createBoundRow(
      config,
      'proj-rf',
      kitOwnedCreationCells({ projectNumber: '2640', clientName: 'Microsoft', projectName: 'New project' }, config.layout),
    )

    assert.equal(requestedEndColumnIndex, 23, 'the RF layout scans every physical Projects column')
    assert.equal(metadataStartIndex, config.headerRow + 1, 'the occupied ID-less row is skipped')
    assert.equal(expandedTableEndIndex, config.headerRow + 2, 'the native Projects table expands through the new row')
  })
})

describe('adoptLegacyProjectRow', () => {
  const config: WorkbookConfig = {
    ...CONFIG,
    layout: 'rf-production-v1',
    sheetId: 904721650,
    headerRow: 4,
  }

  it('adopts and updates the unique existing project row instead of appending a duplicate', async () => {
    let batch: any[] = []
    __setSheetsTransportForTests(async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
      if (url.includes('developerMetadata:search')) return { matchedDeveloperMetadata: [] } as T
      if (url.includes(':getByDataFilter')) {
        return { sheets: [{ properties: { sheetId: config.sheetId }, data: [{ rowData: [
          { values: [{ formattedValue: '2637', effectiveValue: { stringValue: '2637' } }] },
          { values: [{ formattedValue: '2638', effectiveValue: { stringValue: '2638' } }] },
        ] }] }] } as T
      }
      if (decodeURIComponent(url).includes('tables(tableId,range)')) {
        return { sheets: [{ properties: { sheetId: config.sheetId }, tables: [{
          tableId: 'projects-table', range: { sheetId: config.sheetId, startRowIndex: 3, endRowIndex: 20, startColumnIndex: 0, endColumnIndex: 23 },
        }] }] } as T
      }
      if (url.includes(':batchUpdate')) {
        batch = (body as any).requests
        return { replies: [
          ...batch.slice(0, -1).map(() => ({})),
          { createDeveloperMetadata: { developerMetadata: { metadataId: 88 } } },
        ] } as T
      }
      throw new Error(`unexpected url ${url}`)
    })

    const result = await adoptLegacyProjectRow(config, 'project-2637', {
      projectNumber: '2637', client: 'Microsoft', projectName: 'Fabric IQ', lifecycle: 'Active',
      currentStatus: 'Design in progress', startDate: '2026-08-11', deliveryDate: '2026-09-10',
    })
    assert.equal(result.rowIndex, 4, 'row 5 is adopted (headerRow is the zero-based first data row)')
    assert.equal(result.metadataId, 88)
    assert.equal(batch.filter((request) => request.createDeveloperMetadata).length, 1)
    assert.ok(batch.every((request) => !request.updateTable), 'an in-table row does not expand the table')
    const writtenRows = batch.filter((request) => request.updateCells).map((request) => request.updateCells.start.rowIndex)
    assert.ok(writtenRows.length > 0 && writtenRows.every((rowIndex) => rowIndex === 4))
  })

  it('fails closed when a project number appears more than once', async () => {
    let wrote = false
    __setSheetsTransportForTests(async <T>(_method: string, url: string): Promise<T> => {
      if (url.includes('developerMetadata:search')) return { matchedDeveloperMetadata: [] } as T
      if (url.includes(':getByDataFilter')) {
        const cell = { formattedValue: '2637', effectiveValue: { stringValue: '2637' } }
        return { sheets: [{ properties: { sheetId: config.sheetId }, data: [{ rowData: [{ values: [cell] }, { values: [cell] }] }] }] } as T
      }
      if (url.includes(':batchUpdate')) wrote = true
      throw new Error(`unexpected url ${url}`)
    })
    await assert.rejects(
      () => adoptLegacyProjectRow(config, 'project-2637', { projectNumber: '2637' }),
      /adoption ambiguous/,
    )
    assert.equal(wrote, false)
  })

  it('adopts the normalized row when copied metadata exists only on a legacy tab', async () => {
    let wroteMetadata = false
    __setSheetsTransportForTests(async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
      if (url.includes('developerMetadata:search')) {
        return { matchedDeveloperMetadata: [{ developerMetadata: {
          metadataId: 7,
          location: { dimensionRange: { startIndex: 4, sheetId: 1869744848 } },
        } }] } as T
      }
      if (url.includes(':getByDataFilter')) {
        const cell = { formattedValue: '2637', effectiveValue: { stringValue: '2637' } }
        return { sheets: [{ properties: { sheetId: config.sheetId }, data: [{ rowData: [{ values: [cell] }] }] }] } as T
      }
      if (decodeURIComponent(url).includes('tables(tableId,range)')) {
        return { sheets: [{ properties: { sheetId: config.sheetId }, tables: [] }] } as T
      }
      if (url.includes(':batchUpdate')) {
        const requests = (body as { requests: Array<{ createDeveloperMetadata?: unknown }> }).requests
        wroteMetadata = requests.some((request) => Boolean(request.createDeveloperMetadata))
        return { replies: requests.map((request) => request.createDeveloperMetadata
          ? { createDeveloperMetadata: { developerMetadata: { metadataId: 99 } } }
          : {}) } as T
      }
      throw new Error(`unexpected url ${url}`)
    })
    const result = await adoptLegacyProjectRow(config, 'project-2637', { projectNumber: '2637' })
    assert.equal(result.rowIndex, 4)
    assert.equal(result.metadataId, 99)
    assert.equal(wroteMetadata, true)
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

describe('RF Production workbook adapter', () => {
  const config: WorkbookConfig = {
    spreadsheetId: 'sid',
    sheetId: 1869744848,
    headerRow: 4,
    layout: 'rf-production-v1',
    linksSheetId: 1721636671,
    linksHeaderRow: 4,
    templateChannelId: 'C0',
  }
  const c = (value: string): SheetCell => value
    ? { formattedValue: value, effectiveValue: { stringValue: value } }
    : {}

  it('maps Projects A:W plus normalized Links into the stable Canvas row', async () => {
    __setSheetsTransportForTests(async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
      if (!url.includes(':getByDataFilter')) throw new Error(`unexpected url ${url}`)
      const gr = (body as any).dataFilters[0].gridRange
      if (gr.sheetId === config.sheetId) {
        return { sheets: [{ properties: { sheetId: config.sheetId }, data: [{ rowData: [{ values: [
          c('2637'), c('Microsoft'), c('Fabric IQ'), c('Michelle'), c('Client'), c('Active'),
          c('Design'), c('On track'), c('Creative review'), c('08/28/2026'), c('08/11/2026'), c('09/10/2026'),
          c('Steve'), c('Ally'), c('Yes'), c('Custom'), c('Boardomatic V2'), c('https://frame.io/share/latest'), c('08/27/2026'), c('notes'),
          c('Standard Sizzle'), c('Confirmed'), c('Boardomatic V2'),
        ] }] }] }] } as T
      }
      if (gr.sheetId === config.linksSheetId) {
        return { sheets: [{ properties: { sheetId: config.linksSheetId }, data: [{ rowData: [
          { values: [c('2637'), c('Frame.io'), c('Frame.io'), c('https://next.frame.io/project/fabric')] },
          { values: [c('2637'), c('Dropbox (client folder)'), c('Dropbox'), c('https://dropbox.com/fabric')] },
        ] }] }] } as T
      }
      throw new Error(`wrong sheet ${gr.sheetId}`)
    })

    const cells = await readRow(config, 4)
    const at = (header: string) => cells[(MASTER_HEADERS as readonly string[]).indexOf(header)].formattedValue
    assert.equal(cells.length, 25)
    assert.equal(at('Project Number'), '2637')
    assert.equal(at('Client Contact'), 'Michelle')
    assert.equal(at('Quick Status'), 'On track')
    assert.equal(at('Next Share'), 'Creative review')
    assert.equal(at('Start Date'), '08/11/2026')
    assert.equal(at('End Date'), '09/10/2026')
    assert.equal(at('Frame.io'), 'https://next.frame.io/project/fabric')
    assert.equal(at('Dropbox'), 'https://dropbox.com/fabric')
  })

  it('keeps a hyperlinked Link Type as its label while using the URL column hyperlink', async () => {
    __setSheetsTransportForTests(async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
      if (!url.includes(':getByDataFilter')) throw new Error(`unexpected url ${url}`)
      const gr = (body as any).dataFilters[0].gridRange
      if (gr.sheetId === config.sheetId) {
        return { sheets: [{ properties: { sheetId: config.sheetId }, data: [{ rowData: [
          { values: [c('2637')] },
        ] }] }] } as T
      }
      if (gr.sheetId === config.linksSheetId) {
        const linkedType: SheetCell = { ...c('Frame.io'), hyperlink: 'http://Frame.io' }
        const urlCell: SheetCell = { ...c('Open'), hyperlink: 'https://next.frame.io/project/fabric' }
        return { sheets: [{ properties: { sheetId: config.linksSheetId }, data: [{ rowData: [
          { values: [c('2637'), linkedType, c('Frame.io'), urlCell, c('TRUE'), c('20')] },
        ] }] }] } as T
      }
      throw new Error(`wrong sheet ${gr.sheetId}`)
    })

    const supplement = await readProjectSupplement(config, '2637')
    assert.equal(supplement.links[0]['Link Type'], 'Frame.io')
    assert.equal(supplement.links[0].URL, 'https://next.frame.io/project/fabric')
  })

  it('writes new-layout fields to their physical Projects columns', async () => {
    const requests: any[] = []
    __setSheetsTransportForTests(async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
      if (url.includes('developerMetadata:search')) {
        return { matchedDeveloperMetadata: [{ developerMetadata: { metadataId: 9, location: { dimensionRange: { startIndex: 5, sheetId: config.sheetId } } } }] } as T
      }
      if (url.includes(':batchUpdate')) {
        requests.push(...(body as any).requests)
        return { replies: [] } as T
      }
      throw new Error(`unexpected url ${url}`)
    })
    const owned = kitOwnedCreationCells({
      projectNumber: '2637', clientName: 'Microsoft', clientContact: 'Michelle', projectName: 'Fabric IQ',
      projectType: 'Client',
      startDate: '2026-08-11', deadline: '2026-09-10', creativeDirectorName: 'Steve', producerName: 'Ally',
      frameioUrl: 'https://frame.example', dropboxUrl: 'https://dropbox.example',
    }, 'rf-production-v1')
    await updateBoundRow(config, 'project-uuid', owned)
    const cols = requests.map((r) => r.updateCells.start.columnIndex)
    assert.deepEqual(cols, [0, 1, 3, 2, 10, 11, 12, 13, 4])
    assert.ok(!owned.some((x) => x.header === 'Frame.io' || x.header === 'Dropbox'))
  })

  it('atomically carries a renamed Project ID across every normalized source tab', async () => {
    const ids = {
      linksSheetId: 11, specsSheetId: 12, workbackSheetId: 13,
      assignmentsSheetId: 14, deliverablesSheetId: 15, statusLogSheetId: 16,
    }
    const fullConfig: WorkbookConfig = { ...config, ...ids, linksHeaderRow: 4 }
    let written: any[] = []
    __setSheetsTransportForTests(async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
      if (url.includes(':getByDataFilter')) {
        const gr = (body as any).dataFilters[0].gridRange
        const rows = gr.sheetId === ids.workbackSheetId
          ? [{ values: [c('2637')] }, { values: [c('2637')] }]
          : [{ values: [c('2637')] }]
        return { sheets: [{ properties: { sheetId: gr.sheetId }, data: [{ rowData: rows }] }] } as T
      }
      if (url.includes(':batchUpdate')) {
        written = (body as any).requests
        return { replies: [] } as T
      }
      throw new Error(`unexpected url ${url}`)
    })

    await renameNormalizedProjectRecords(fullConfig, '2637', '2637A')
    assert.equal(written.length, 7)
    assert.deepEqual(new Set(written.map((r) => r.updateCells.start.sheetId)), new Set(Object.values(ids)))
    assert.ok(written.every((r) => r.updateCells.start.columnIndex === 0))
    assert.ok(written.every((r) => r.updateCells.rows[0].values[0].userEnteredValue.stringValue === '2637A'))
  })

  it('upserts provider links and renames every link row without duplicates', async () => {
    const batches: any[][] = []
    const linkRows = [
      { values: [c('2637'), c('Frame.io'), c('Frame.io'), c('old-frame')] },
      { values: [c('2637'), c('Dropbox (client folder)'), c('Dropbox'), c('old-dropbox')] },
    ]
    __setSheetsTransportForTests(async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
      if (url.includes(':getByDataFilter')) {
        return { sheets: [{ properties: { sheetId: config.linksSheetId }, data: [{ rowData: linkRows }] }] } as T
      }
      if (url.includes(':batchUpdate')) {
        batches.push((body as any).requests)
        return { replies: [] } as T
      }
      throw new Error(`unexpected url ${url}`)
    })
    await upsertProjectLinks(config, '2637', { frameioUrl: 'new-frame', dropboxUrl: 'new-dropbox' })
    assert.deepEqual(batches[0].map((r) => r.updateCells.start), [
      { sheetId: config.linksSheetId, rowIndex: 4, columnIndex: 3 },
      { sheetId: config.linksSheetId, rowIndex: 5, columnIndex: 3 },
    ])
    await renameProjectLinks(config, '2637', '2637A')
    assert.deepEqual(batches[1].map((r) => r.updateCells.start.columnIndex), [0, 0])
    assert.deepEqual(batches[1].map((r) => r.updateCells.rows[0].values[0].userEnteredValue.stringValue), ['2637A', '2637A'])
  })

  it('appends workback rows by Project ID and expands a formula-prefilled grid', async () => {
    const workbackSheetId = 1186252714
    const workbackConfig: WorkbookConfig = {
      ...config,
      workbackSheetId,
    }
    type WorkbackBatchRequest =
      | { appendDimension: { sheetId: number; dimension: string; length: number } }
      | { updateCells: {
          start: { sheetId: number; rowIndex: number; columnIndex: number }
          rows: Array<{ values: unknown[] }>
        } }
      | { updateTable: { table: { tableId: string; range: { endRowIndex: number } }; fields: string } }
    const batches: WorkbackBatchRequest[][] = []
    const readWidths: number[] = []

    __setSheetsTransportForTests(async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
      if (url.includes(':getByDataFilter')) {
        const gr = (body as {
          dataFilters: Array<{ gridRange: { sheetId: number; startColumnIndex: number; endColumnIndex: number } }>
        }).dataFilters[0].gridRange
        assert.equal(gr.sheetId, workbackSheetId)
        readWidths.push(gr.endColumnIndex - gr.startColumnIndex)
        // Row 4 is occupied. Rows 5-9 have blank Project IDs but formula cells
        // in column H, matching the production Workback template.
        const rowData = [
          { values: [c('2600')] },
          ...Array.from({ length: 5 }, () => ({
            values: gr.endColumnIndex > 1
              ? [...Array.from({ length: 7 }, () => c('')), c('0%')]
              : [],
          })),
        ]
        return { sheets: [{ properties: { sheetId: workbackSheetId }, data: [{ rowData }] }] } as T
      }
      if (decodeURIComponent(url).includes('tables(tableId,range)')) {
        return { sheets: [{
          properties: { sheetId: workbackSheetId },
          tables: [{ tableId: 'workback-table', range: {
            sheetId: workbackSheetId, startRowIndex: 3, endRowIndex: 5,
            startColumnIndex: 0, endColumnIndex: 12,
          } }],
        }] } as T
      }
      if (url.includes('?fields=') && _method === 'GET') {
        return { sheets: [{ properties: { sheetId: workbackSheetId, gridProperties: { rowCount: 10 } } }] } as T
      }
      if (url.includes(':batchUpdate')) {
        batches.push((body as { requests: WorkbackBatchRequest[] }).requests)
        return { replies: [] } as T
      }
      throw new Error(`unexpected url ${url}`)
    })

    await seedNormalizedProjectTables(workbackConfig, {
      projectNumber: '9998',
      clientName: 'Internal',
      projectName: 'E2E',
      startDate: '2026-08-27',
      deadline: '2026-09-04',
      milestoneCount: 9,
      workbackTemplate: 'Standard Sizzle',
    })

    assert.deepEqual(readWidths, [1, 1], 'project detection and allocation only inspect the Project ID column')
    assert.equal(batches.length, 1)
    assert.deepEqual(batches[0][0], {
      appendDimension: { sheetId: workbackSheetId, dimension: 'ROWS', length: 4 },
    })
    const write = batches[0][1] as Extract<WorkbackBatchRequest, { updateCells: unknown }>
    assert.deepEqual(write.updateCells.start, {
      sheetId: workbackSheetId,
      rowIndex: 5,
      columnIndex: 0,
    })
    assert.equal(write.updateCells.rows.length, 9)
    const tableUpdate = batches[0][2] as Extract<WorkbackBatchRequest, { updateTable: unknown }>
    assert.equal(tableUpdate.updateTable.table.tableId, 'workback-table')
    assert.equal(tableUpdate.updateTable.table.range.endRowIndex, 14)
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

describe('transient Google read recovery', () => {
  it('retries a temporary 503 from getByDataFilter and returns the requested row', async () => {
    let attempts = 0
    __setSheetsTransportForTests(async <T>(_method: string, url: string): Promise<T> => {
      assert.match(url, /:getByDataFilter/)
      attempts++
      if (attempts < 3) throw new Error(`Google POST ${url.split('?')[0]} failed (503): backend unavailable`)
      return {
        sheets: [{
          properties: { sheetId: CONFIG.sheetId },
          data: [{ rowData: [{ values: [{ formattedValue: '2601' }] }] }],
        }],
      } as T
    })

    const row = await readRow(CONFIG, 4)

    assert.equal(attempts, 3)
    assert.equal(row[0]?.formattedValue, '2601')
  })

  it('does not retry a non-transient Google error', async () => {
    let attempts = 0
    __setSheetsTransportForTests(async <T>(): Promise<T> => {
      attempts++
      throw new Error('Google POST failed (403): forbidden')
    })

    await assert.rejects(() => readRow(CONFIG, 4), /403/)
    assert.equal(attempts, 1)
  })
})
