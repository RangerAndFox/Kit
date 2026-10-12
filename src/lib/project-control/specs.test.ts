import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { SPEC_HEADERS, approvedSpecReply, specEditSchema, specHash, specValues } from './specs'
import { __setSheetsTransportForTests, readBoundProjectSpecs, writeBoundProjectSpecs } from './sheets'
import type { WorkbookConfig } from './types'

const config: WorkbookConfig = { spreadsheetId: 's', sheetId: 1, specsSheetId: 2, headerRow: 4, layout: 'rf-production-v1', templateChannelId: 'C' }
const edit = { dimensions: '3840 x 2160', frameRate: '24', duration: '', audio: '', fileType: 'MOV', notes: '' }
afterEach(() => __setSheetsTransportForTests(null))

function fixture(options: { duplicate?: boolean; wrongHeader?: boolean; timeout?: boolean } = {}) {
  let values = ['2635', '1920 x 1080', '23.976', '', '', 'MOV', 'private freeform note', 'Needs Review']
  let writes = 0
  __setSheetsTransportForTests(async <T>(_method: string, url: string, body?: unknown): Promise<T> => {
    if (url.endsWith('developerMetadata:search')) return { matchedDeveloperMetadata: [{ developerMetadata: { metadataId: 3, location: { dimensionRange: { sheetId: 1, startIndex: 8 } } } }] } as T
    if (url.endsWith(':batchUpdate')) {
      writes++
      const request = (body as { requests: { updateCells: { start: { sheetId: number; rowIndex: number; columnIndex: number }; rows: { values: { userEnteredValue: { stringValue: string } }[] }[]; fields: string } }[] }).requests[0].updateCells
      assert.deepEqual(request.start, { sheetId: 2, rowIndex: 4, columnIndex: 1 })
      assert.equal(request.fields, 'userEnteredValue')
      values = ['2635', ...request.rows[0].values.map(v => v.userEnteredValue.stringValue)]
      if (options.timeout) throw new Error('timeout after provider commit')
      return {} as T
    }
    const range = (body as { dataFilters: { gridRange: { sheetId: number; startRowIndex: number } }[] }).dataFilters[0].gridRange
    const rows = range.sheetId === 1 ? [['2635']] : range.startRowIndex === 3
      ? [[...(options.wrongHeader ? ['WRONG', ...SPEC_HEADERS.slice(1)] : SPEC_HEADERS)]]
      : options.duplicate ? [values, values] : [values]
    return { sheets: [{ properties: { sheetId: range.sheetId }, data: [{ rowData: rows.map(row => ({ values: row.map(formattedValue => ({ formattedValue })) })) }] }] } as T
  })
  return { writes: () => writes, change: () => { values[2] = '30' } }
}
test('4K requires exact pixels and 24 is not normalized to 23.976', () => {
  assert.equal(specEditSchema.safeParse({ ...edit, dimensions: '4K' }).success, false)
  assert.equal(specEditSchema.parse(edit).frameRate, '24')
  assert.equal(specEditSchema.safeParse({ ...edit, frameRate: '0' }).success, false)
})
test('artist specs are confirmed-only and never include freeform notes', () => {
  const values = [...specValues('2635', edit)]; values[6] = 'secret budget $100000'
  const snapshot = { values, hash: specHash(values), rowIndex: 4, projectNumber: '2635' }
  assert.doesNotMatch(approvedSpecReply(snapshot, true), /secret|100000/)
  snapshot.values[7] = 'Needs Review'
  assert.doesNotMatch(approvedSpecReply(snapshot, true), /3840|24/)
  assert.match(approvedSpecReply(snapshot, false), /Unconfirmed/)
})
test('writes only bound Specs B:H and verifies confirmation', async () => {
  const f = fixture()
  const current = await readBoundProjectSpecs(config, 'p')
  const result = await writeBoundProjectSpecs(config, 'p', current.hash, edit, async () => {})
  assert.deepEqual(result.values, specValues('2635', edit))
  assert.equal(f.writes(), 1)
})
test('intervening changes and lost ownership prevent writes', async () => {
  const f = fixture(); const current = await readBoundProjectSpecs(config, 'p'); f.change()
  await assert.rejects(writeBoundProjectSpecs(config, 'p', current.hash, edit, async () => {}), /changed since/)
  assert.equal(f.writes(), 0)
  const fresh = await readBoundProjectSpecs(config, 'p')
  await assert.rejects(writeBoundProjectSpecs(config, 'p', fresh.hash, edit, async () => { throw new Error('lost lease') }), /lost lease/)
  assert.equal(f.writes(), 0)
})
test('ambiguous rows and changed columns fail closed', async () => {
  fixture({ duplicate: true }); await assert.rejects(readBoundProjectSpecs(config, 'p'), /exactly one Specs row/)
  fixture({ wrongHeader: true }); await assert.rejects(readBoundProjectSpecs(config, 'p'), /layout changed/)
})
test('uncertain provider write is never blindly retried', async () => {
  const f = fixture({ timeout: true }); const current = await readBoundProjectSpecs(config, 'p')
  await assert.rejects(writeBoundProjectSpecs(config, 'p', current.hash, edit, async () => {}), /timeout/)
  assert.equal(f.writes(), 1)
})
