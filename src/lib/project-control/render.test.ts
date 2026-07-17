/**
 * Tests for the Project Control pure-logic core: cell normalization, source-row
 * hashing (hyperlink-aware), Kit-owned creation field mapping, and deterministic
 * Canvas rendering from a stored template snapshot.
 *
 * Run: npx tsx --test src/lib/project-control/render.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCell,
  normalizeRow,
  sourceRowHash,
  kitOwnedCreationCells,
  renderProjectControlCanvas,
  parseDateToSerial,
  NEVER_WRITE_HEADERS,
  MASTER_HEADERS,
  headerToA1Column,
  type SheetCell,
} from './render'

// ─── normalizeCell ───────────────────────────────────────────────────────────

describe('normalizeCell', () => {
  it('normalizes a plain string cell', () => {
    const c: SheetCell = { formattedValue: 'Nike', effectiveValue: { stringValue: 'Nike' } }
    const n = normalizeCell(c)
    assert.equal(n.display, 'Nike')
    assert.equal(n.value, 'Nike')
    assert.equal(n.hyperlink, null)
    assert.equal(n.iso, null)
  })

  it('preserves an explicit hyperlink target distinct from the display text', () => {
    const c: SheetCell = { formattedValue: 'Frame.io', hyperlink: 'https://frame.io/abc' }
    const n = normalizeCell(c)
    assert.equal(n.display, 'Frame.io')
    assert.equal(n.hyperlink, 'https://frame.io/abc')
  })

  it('extracts the URL from a =HYPERLINK() formula cell', () => {
    const c: SheetCell = {
      formattedValue: 'Dropbox',
      userEnteredValue: { formulaValue: '=HYPERLINK("https://dropbox.com/x","Dropbox")' },
    }
    const n = normalizeCell(c)
    assert.equal(n.hyperlink, 'https://dropbox.com/x')
  })

  it('converts a DATE-formatted serial number to an ISO date', () => {
    // Serial 45838 == 2025-07-04 (Sheets epoch 1899-12-30).
    const c: SheetCell = {
      formattedValue: '7/4/2025',
      effectiveValue: { numberValue: 45842 },
      effectiveFormat: { numberFormat: { type: 'DATE' } },
    }
    const n = normalizeCell(c)
    assert.equal(n.iso, '2025-07-04')
    assert.equal(n.display, '7/4/2025')
  })

  it('treats an empty cell as blank, not a crash', () => {
    const n = normalizeCell({})
    assert.equal(n.display, '')
    assert.equal(n.value, null)
    assert.equal(n.hyperlink, null)
  })
})

// ─── sourceRowHash ───────────────────────────────────────────────────────────

describe('sourceRowHash', () => {
  const base = normalizeRow(MASTER_HEADERS, MASTER_HEADERS.map((h) =>
    h === 'Client' ? ({ formattedValue: 'Nike', effectiveValue: { stringValue: 'Nike' } }) : ({}),
  ))

  it('is deterministic for identical input', () => {
    const again = normalizeRow(MASTER_HEADERS, MASTER_HEADERS.map((h) =>
      h === 'Client' ? ({ formattedValue: 'Nike', effectiveValue: { stringValue: 'Nike' } }) : ({}),
    ))
    assert.equal(sourceRowHash(base), sourceRowHash(again))
  })

  it('changes when only a hyperlink target changes (display identical)', () => {
    const withLink = normalizeRow(MASTER_HEADERS, MASTER_HEADERS.map((h) =>
      h === 'Frame.io' ? ({ formattedValue: 'link', hyperlink: 'https://frame.io/a' }) : ({}),
    ))
    const withOtherLink = normalizeRow(MASTER_HEADERS, MASTER_HEADERS.map((h) =>
      h === 'Frame.io' ? ({ formattedValue: 'link', hyperlink: 'https://frame.io/b' }) : ({}),
    ))
    assert.notEqual(sourceRowHash(withLink), sourceRowHash(withOtherLink))
  })
})

// ─── kitOwnedCreationCells ───────────────────────────────────────────────────

describe('kitOwnedCreationCells', () => {
  it('emits only Kit-owned columns, by A1 letter, skipping blanks', () => {
    const cells = kitOwnedCreationCells({
      projectNumber: '2601',
      clientName: 'Nike',
      projectName: 'Summer',
      frameioUrl: 'https://frame.io/x',
      dropboxUrl: 'https://dropbox.com/y',
    })
    const byCol = Object.fromEntries(cells.map((c) => [c.column, c.value]))
    assert.equal(byCol['A'], '2601') // Project Number
    assert.equal(byCol['B'], 'Nike') // Client
    assert.equal(byCol['D'], 'Summer') // Project Name
    assert.equal(byCol['R'], 'https://frame.io/x') // Frame.io
    assert.equal(byCol['S'], 'https://dropbox.com/y') // Dropbox
    // Nothing written to unknown/blank fields.
    assert.equal(byCol['C'], undefined) // Client Contact not supplied
  })

  it('never emits Current Margin (U) or Projected Margin (V)', () => {
    const cells = kitOwnedCreationCells({ projectNumber: '1', clientName: 'x', projectName: 'y' })
    const cols = cells.map((c) => c.column)
    assert.ok(!cols.includes('U'))
    assert.ok(!cols.includes('V'))
  })
})

describe('NEVER_WRITE_HEADERS', () => {
  it('contains both margin columns', () => {
    assert.ok(NEVER_WRITE_HEADERS.includes('Current Margin'))
    assert.ok(NEVER_WRITE_HEADERS.includes('Projected Margin'))
  })
})

describe('parseDateToSerial', () => {
  it('converts a valid ISO date to a serial number', () => {
    assert.equal(parseDateToSerial('2025-07-04'), 45842)
  })
  it('returns null for an absent date', () => {
    assert.equal(parseDateToSerial(undefined), null)
    assert.equal(parseDateToSerial(''), null)
  })
  it('returns null for an invalid / impossible date (never text)', () => {
    assert.equal(parseDateToSerial('not-a-date'), null)
    assert.equal(parseDateToSerial('2026-02-31'), null)
    assert.equal(parseDateToSerial('07/04/2025'), null)
  })
})

describe('kitOwnedCreationCells dates', () => {
  it('emits valid dates as date cells with a serial, and drops invalid ones', () => {
    const cells = kitOwnedCreationCells({ projectNumber: '1', clientName: 'c', projectName: 'p', startDate: '2025-07-04', deadline: 'garbage' })
    const start = cells.find((c) => c.header === 'Start Date')
    const end = cells.find((c) => c.header === 'End Date')
    assert.equal(start?.kind, 'date')
    assert.equal(start?.serial, 45842)
    assert.equal(end, undefined) // invalid deadline dropped, never text
  })
})

describe('headerToA1Column', () => {
  it('maps headers to their A:Y letters', () => {
    assert.equal(headerToA1Column('Project Number'), 'A')
    assert.equal(headerToA1Column('Frame.io'), 'R')
    assert.equal(headerToA1Column('Dropbox'), 'S')
    assert.equal(headerToA1Column('Delivery Link'), 'Y')
  })
})

// ─── renderProjectControlCanvas ──────────────────────────────────────────────

const TEMPLATE = `# 🎬 2xxx Client Project

| ### **Client** |  |
| ### **Contacts** |  |
| ### **Producer** |  |
| ### **CD** |  |
| ### **VO** |  |

## Assets Folders

| ### Dropbox |  |
| ### [Frame.io](http://Frame.io) |  |
`

describe('renderProjectControlCanvas', () => {
  const row = normalizeRow(MASTER_HEADERS, MASTER_HEADERS.map((h) => {
    switch (h) {
      case 'Project Number': return { formattedValue: '2601', effectiveValue: { stringValue: '2601' } }
      case 'Client': return { formattedValue: 'Nike', effectiveValue: { stringValue: 'Nike' } }
      case 'Project Name': return { formattedValue: 'Summer', effectiveValue: { stringValue: 'Summer' } }
      case 'Producer': return { formattedValue: 'Alex', effectiveValue: { stringValue: 'Alex' } }
      case 'Frame.io': return { formattedValue: 'Frame.io', hyperlink: 'https://frame.io/z' }
      default: return {}
    }
  }))
  const out = renderProjectControlCanvas(TEMPLATE, row)

  it('fills Client from the authoritative row', () => {
    assert.match(out, /\|\s*### \*\*Client\*\*\s*\|\s*Nike\s*\|/)
  })

  it('renders a hyperlink cell as [display](target)', () => {
    assert.match(out, /\[Frame\.io\]\(https:\/\/frame\.io\/z\)/)
  })

  it('replaces the placeholder H1 with the project spine', () => {
    assert.match(out, /# .*2601_Nike_Summer/)
    assert.doesNotMatch(out, /2xxx Client Project/)
  })

  it('is deterministic / idempotent (re-render equals render)', () => {
    assert.equal(renderProjectControlCanvas(out, row), renderProjectControlCanvas(TEMPLATE, row))
  })
})
