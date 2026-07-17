/**
 * Sheets client tests via an injected transport (no network, no creds).
 *
 * Run: npx tsx --test src/lib/project-control/sheets.test.ts
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createBoundRow, searchRowMetadata, __setSheetsTransportForTests } from './sheets'
import { kitOwnedCreationCells, parseDateToSerial } from './render'
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
