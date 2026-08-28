import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderOverviewView, renderScheduleView, type ProjectSupplement } from './views'
import type { NormalizedRow } from './render'

const cell = (display: string) => ({ display, value: display, hyperlink: null, iso: null })
const row: NormalizedRow = {
  'Project Number': cell('2637'),
  'Project Name': cell('Fabric IQ'),
  Client: cell('Microsoft'),
  'Quick Status': cell('Line one\nLine two'),
  'Next Share': cell('Review | approval'),
  'Start Date': cell('8/11/2026'),
  'End Date': cell('9/10/2026'),
}
const supplement: ProjectSupplement = {
  specs: {}, links: [], deliverables: [], assignments: [], scheduleStatus: 'Draft',
  workback: [{
    Task: 'Revise boards | timing edit', 'Start Date': '2026-08-19', 'Due Date': '2026-08-21',
    Owner: '', Status: 'Not Started', 'Show on Canvas': 'TRUE', 'Sort Order': '1',
  }],
}

describe('generated Canvas tables', () => {
  it('keeps multiline status and pipe characters inside a single table cell', () => {
    const markdown = renderOverviewView(row, supplement)
    assert.match(markdown, /Line one<br>Line two/)
    assert.match(markdown, /Review \\| approval/)
    assert.doesNotMatch(markdown, /Line one\nLine two/)
  })

  it('renders an intentional assignments table when nobody is assigned today', () => {
    const markdown = renderOverviewView(row, supplement)
    assert.match(markdown, /\| Artist \| Assignment \|/)
    assert.match(markdown, /\| — \| No assignments for today \|/)
  })

  it('escapes milestone pipes so schedule columns remain aligned', () => {
    const markdown = renderScheduleView(row, supplement)
    assert.match(markdown, /Revise boards \\| timing edit/)
  })
})
