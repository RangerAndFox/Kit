import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { projectControlDay, projectViewHash, PROJECT_VIEW_RENDER_VERSION, renderNotesAndFeedbackView, renderOverviewView, renderReferenceView, renderScheduleView, type ProjectSupplement } from './views'
import { createHash } from 'node:crypto'
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
  const scheduleTasks = (workback: ProjectSupplement['workback']) => renderScheduleView(row, { ...supplement, workback })
    .split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Milestone') && !line.startsWith('| ---'))
    .map(line => line.split(' | ')[0].slice(2))

  it('orders the 2645 regression by dates, not blank or stale Sort Order', () => {
    const workback: ProjectSupplement['workback'] = [
      { Task: 'Client Feedback', 'Start Date': '2026-10-07', 'Due Date': '2026-10-07', 'Sort Order': '' },
      { Task: 'Final Delivery', 'Start Date': '2026-11-06', 'Due Date': '2026-11-06', 'Sort Order': '-1' },
      { Task: 'Storyboard V1', 'Start Date': '2026-09-30', 'Due Date': '2026-10-06', 'Sort Order': '8', Status: 'In Progress' },
      { Task: 'Storyboard V2', 'Start Date': '2026-10-07', 'Due Date': '2026-10-09', 'Sort Order': '0' },
    ]
    const original = structuredClone(workback)
    assert.deepEqual(scheduleTasks(workback), ['**Storyboard V1**', 'Client Feedback', 'Storyboard V2', 'Final Delivery'])
    assert.deepEqual(workback, original)
  })

  it('handles US dates, deadline-only rows, invalid dates and undated rows deterministically', () => {
    assert.deepEqual(scheduleTasks([
      { Task: 'Undated', 'Sort Order': '-100' },
      { Task: 'Invalid date', 'Start Date': '2026-02-31' },
      { Task: 'Next year', 'Start Date': '1/2/2027' },
      { Task: 'Earlier', 'Start Date': ' 9/30/2026 ' },
      { Task: 'Deadline only', 'Due Date': '2026-10-01' },
      { Task: 'Hidden', 'Start Date': '2026-01-01', 'Show on Canvas': 'FALSE' },
    ]), ['Earlier', 'Deadline only', 'Next year', 'Undated', 'Invalid date'])
  })

  it('uses explicit sort order only for equal dates and retains source order for equal keys', () => {
    const dates = { 'Start Date': '2026-10-09', 'Due Date': '2026-10-09' }
    assert.deepEqual(scheduleTasks([
      { ...dates, Task: 'Blank' }, { ...dates, Task: 'Two', 'Sort Order': '2' },
      { ...dates, Task: 'One', 'Sort Order': '1' }, { ...dates, Task: 'Invalid order', 'Sort Order': 'abc' },
    ]), ['One', 'Two', 'Blank', 'Invalid order'])
  })

  it('invalidates the old canvas render hash even when the workbook has not changed', () => {
    assert.notEqual(PROJECT_VIEW_RENDER_VERSION, '9')
    const previous = createHash('sha256').update(JSON.stringify({ renderVersion: '9', row, extra: supplement })).digest('hex')
    assert.notEqual(projectViewHash(row, supplement), previous)
  })

  it('replaces the Overview notice and duplicate info table while retaining the status and share data', () => {
    const markdown = renderOverviewView({ ...row,
      'Last Share': { ...cell('Boards V2'), hyperlink: 'https://example.test/review' },
    }, supplement, '2026-10-09T20:11:00Z')
    assert.match(markdown, /^\*\*Last synced:\*\* Oct 9, 2026, 1:11 PM PDT/)
    assert.doesNotMatch(markdown, /Generated view|do not edit here|Master Project List|## Project info|## Latest share/)
    assert.match(markdown, /## Project Status\n/)
    assert.match(markdown, /\[Boards V2\]\(https:\/\/example.test\/review\)/)
    assert.equal(markdown.split('| Status |').length - 1, 1)
    assert.equal(markdown.split('| Next Milestone |').length - 1, 1)
    assert.match(markdown, /## Today’s assignments/)
    assert.match(markdown, /PDT\n\n## Today’s assignments/)
    assert.doesNotMatch(markdown, /# 2637|Fabric IQ/)
    assert.match(markdown, /## Asset folders/)
    assert.match(renderReferenceView(row, supplement), /Generated view/)
    assert.match(renderScheduleView(row, supplement), /Generated view/)
  })

  it('links refresh beside the timestamp only for a verified Slack message URL', () => {
    const url = 'https://rangerfox.slack.com/archives/C123/p1234567890'
    assert.match(renderOverviewView(row, supplement, '2026-10-09T20:11:00Z', url), /PDT · \[Refresh this project\]/)
    assert.doesNotMatch(renderOverviewView(row, supplement, '2026-10-09T20:11:00Z', 'https://evil.test'), /Refresh this project/)
  })

  it('uses Pacific daylight-saving time and never invents a timestamp from invalid input', () => {
    assert.match(renderOverviewView(row, supplement, '2026-12-09T21:11:00Z'), /1:11 PM PST/)
    assert.match(renderOverviewView(row, supplement, 'invalid'), /^\*\*Last synced:\*\* Unavailable/)
    const hash = projectViewHash(row, supplement)
    renderOverviewView(row, supplement, '2026-10-10T20:11:00Z')
    assert.equal(projectViewHash(row, supplement), hash, 'the clock is not a source change')
  })

  it('shows the 2645 Ted assignment on its Pacific date after UTC and Eastern midnight', () => {
    const extra = { ...supplement, assignments: [
      { Date: '2026-10-09', Person: 'Ted', 'Daily Assignment': 'Look dev on Cloud environment' },
      { Date: '2026-10-10', Person: 'Tomorrow', 'Daily Assignment': 'Next day work' },
    ] }
    for (const instant of ['2026-10-10T03:55:05.377Z', '2026-10-10T06:59:59Z']) {
      const markdown = renderOverviewView(row, extra, instant)
      assert.match(markdown, /\| Ted \| Look dev on Cloud environment \|/)
      assert.doesNotMatch(markdown, /No assignments|Next day work/)
    }
    const nextDay = renderOverviewView(row, extra, '2026-10-10T07:00:00Z')
    assert.match(nextDay, /Next day work/)
    assert.doesNotMatch(nextDay, /Look dev on Cloud environment/)
    assert.doesNotMatch(renderOverviewView(row, extra, 'invalid'), /Look dev|Next day work/)
  })

  it('uses local midnight across winter, DST changes and year rollover', () => {
    for (const [instant, expected] of [
      ['2026-12-10T07:59:59Z', '2026-12-09'], ['2026-12-10T08:00:00Z', '2026-12-10'],
      ['2026-03-08T09:59:59Z', '2026-03-08'], ['2026-03-08T10:00:00Z', '2026-03-08'],
      ['2026-11-01T08:59:59Z', '2026-11-01'], ['2026-11-01T09:00:00Z', '2026-11-01'],
      ['2027-01-01T07:59:59Z', '2026-12-31'], ['2027-01-01T08:00:00Z', '2027-01-01'],
    ]) assert.equal(projectControlDay(instant), expected)
    assert.equal(projectControlDay('invalid'), null)
  })

  it('invalidates assignment projections on a new Pacific day, not on every tick', () => {
    const extra = { ...supplement, assignments: [{ Date: '2026-10-09', Person: 'Ted', 'Daily Assignment': 'Design' }] }
    const hashAt = (instant: string) => projectViewHash(row, extra, projectControlDay(instant))
    assert.equal(hashAt('2026-10-09T23:55:00Z'), hashAt('2026-10-10T06:59:59Z'))
    assert.notEqual(hashAt('2026-10-10T06:59:59Z'), hashAt('2026-10-10T07:00:00Z'))
    assert.equal(projectViewHash(row, supplement, '2026-10-09'), projectViewHash(row, supplement, '2026-10-10'))
  })

  it('adds a OneDrive row once, including normalized duplicate types', () => {
    const markdown = renderOverviewView(row, { ...supplement, links: [
      { 'Link Type': 'OneDrive', URL: 'https://example.test/old', Active: 'TRUE' },
      { 'Link Type': ' one drive ', URL: 'https://example.test/current', Active: 'TRUE' },
    ] })
    assert.equal(markdown.split('| OneDrive |').length - 1, 1)
    assert.match(markdown, /\[OneDrive\]\(https:\/\/example.test\/current\)/)
    assert.doesNotMatch(markdown, /example.test\/old/)
    assert.equal(renderOverviewView(row, { ...supplement, links: [] }).includes('| OneDrive |'), false)
  })
  it('publishes every explicit Figma and Script asset while collapsing duplicate URLs', () => {
    const first = { 'Link Type':'Figma', URL:'https://www.figma.com/design/FIRST' }
    const markdown = renderOverviewView(row,{...supplement,links:[first,first,
      { 'Link Type':'Figma', URL:'https://www.figma.com/design/SECOND' },
      { 'Link Type':'Script', URL:'https://docs.google.com/document/d/ONE' },
      { 'Link Type':'Script', URL:'https://docs.google.com/document/d/TWO' },
    ]})
    assert.equal(markdown.split('| Figma |').length-1,2)
    assert.equal(markdown.split('| Script |').length-1,2)
    assert.match(markdown,/FIRST/); assert.match(markdown,/SECOND/)
  })

  it('does not project inactive, unknown, or restricted asset types', () => {
    const markdown = renderOverviewView(row, { ...supplement, links: [
      { 'Link Type': 'OneDrive', URL: 'https://example.test/inactive', Active: 'FALSE' },
      { 'Link Type': 'Other', Label: 'OneDrive', URL: 'https://example.test/private' },
      { 'Link Type': 'Budget', URL: 'https://example.test/budget' },
      { 'Link Type': 'Harvest', URL: 'https://example.test/harvest' },
    ] })
    assert.doesNotMatch(markdown, /example.test|\| OneDrive \||\| Other \||\| Budget \||\| Harvest \|/)
  })

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
    assert.match(markdown, /edit this canvas directly/)
    assert.match(markdown, /Keep budgets, client contacts, and other sensitive information in producer-only systems/)
    assert.doesNotMatch(markdown, /Generated view — do not edit here/)
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
