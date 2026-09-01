import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderNotesAndFeedbackView, renderOverviewView, renderScheduleView, type ProjectSupplement } from './views'
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

  it('does not expose the producer-only Harvest link in the project overview', () => {
    const markdown = renderOverviewView(row, {
      ...supplement,
      links: [{ 'Link Type': 'Harvest', URL: 'https://example.test/harvest/project/2637' }],
    })
    assert.doesNotMatch(markdown, /Harvest/)
    assert.doesNotMatch(markdown, /example\.test\/harvest/)
  })

  it('escapes milestone pipes so schedule columns remain aligned', () => {
    const markdown = renderScheduleView(row, supplement)
    assert.match(markdown, /Revise boards \\| timing edit/)
  })

  it('renders a team-safe notes and feedback log without sensitive producer fields', () => {
    const markdown = renderNotesAndFeedbackView(row, {
      ...supplement,
      statusLog: [{ Date: '2026-08-31', Update: 'Client approved boards', 'Updated By': 'Kit', Visibility: 'Team' }],
    })
    assert.match(markdown, /2637 — Notes & Feedback/)
    assert.match(markdown, /Client approved boards/)
    assert.match(markdown, /Budgets and client contacts are intentionally excluded/)
    assert.doesNotMatch(markdown, /Michelle|\$[0-9]/)
  })

  it('fails closed on private or unclassified producer notes', () => {
    const markdown = renderNotesAndFeedbackView(row, {
      ...supplement,
      statusLog: [
        { Date: '2026-08-31', Update: 'Budget is $50,000', 'Updated By': 'Producer', Visibility: 'Private' },
        { Date: '2026-08-30', Update: 'Call Michelle at 555-0100', 'Updated By': 'Producer' },
      ],
    })
    assert.match(markdown, /No notes or feedback yet/)
    assert.doesNotMatch(markdown, /50,000|Michelle|555-0100/)
  })

  it('renders an intentional empty notes table before the first update', () => {
    const markdown = renderNotesAndFeedbackView(row, supplement)
    assert.match(markdown, /\| Date \| Update \| Updated By \|/)
    assert.match(markdown, /No notes or feedback yet/)
  })
})
