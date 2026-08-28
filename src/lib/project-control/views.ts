import { createHash } from 'node:crypto'
import { GENERATED_VIEW_NOTICE, type NormalizedRow } from './render'

export interface ProjectSupplement {
  scheduleStatus?: string
  specs: Record<string, string>
  workback: Array<Record<string, string>>
  links: Array<Record<string, string>>
  deliverables: Array<Record<string, string>>
  assignments: Array<Record<string, string>>
}

// Bump when generated Canvas markup changes so the sync cursor performs one
// complete regeneration even if the workbook itself has not changed.
export const PROJECT_VIEW_RENDER_VERSION = '2'

const val = (row: NormalizedRow, key: string) => row[key]?.display || '—'
const link = (label: string, url?: string) => url ? `[${label}](${url})` : '—'
const tableCell = (value: string) => (value || '—')
  .replace(/\|/g, '\\|')
  .replace(/\r?\n/g, '<br>')
const table = (headers: string[], rows: string[][]) => [
  `| ${headers.map(tableCell).join(' | ')} |`,
  `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map((r) => `| ${r.map(tableCell).join(' | ')} |`),
].join('\n')

export function projectViewHash(row: NormalizedRow, extra: ProjectSupplement): string {
  return createHash('sha256').update(JSON.stringify({ renderVersion: PROJECT_VIEW_RENDER_VERSION, row, extra })).digest('hex')
}

export function renderOverviewView(row: NormalizedRow, extra: ProjectSupplement): string {
  const today = new Date().toISOString().slice(0, 10)
  const assignments = extra.assignments.filter((a) => a.Date === today)
  const assignmentRows = assignments.length > 0
    ? assignments.map((a) => [a.Person, a['Daily Assignment']])
    : [['—', 'No assignments for today']]
  const links = Object.fromEntries(extra.links.map((x) => [x['Link Type'], x.URL]))
  return `${GENERATED_VIEW_NOTICE}\n\n# ${val(row, 'Project Number')} — ${val(row, 'Project Name')}\n\n` +
    `## Project info\n${table(['Field', 'Value'], [
      ['Client', val(row, 'Client')], ['Status', val(row, 'Quick Status')], ['Next Milestone', val(row, 'Next Share')],
    ])}\n\n## Today’s assignments\n${table(['Artist', 'Assignment'], assignmentRows)}\n\n` +
    `## Latest share\n${table(['Field', 'Value'], [['Last Share', row['Last Share']?.hyperlink ? link(row['Last Share'].display, row['Last Share'].hyperlink) : val(row, 'Last Share')], ['Status', val(row, 'Quick Status')], ['Next Milestone', val(row, 'Next Share')]])}\n\n` +
    `## Asset folders\n${table(['Asset', 'Link'], ['Dropbox','Frame.io','Figma','Script','Boords','Client Visual Reference','Music Reference','ElevenLabs','Harvest'].map((k) => [k, link(k, links[k])]))}`
}

export function renderReferenceView(row: NormalizedRow, extra: ProjectSupplement): string {
  const s = extra.specs
  return `${GENERATED_VIEW_NOTICE}\n\n# ${val(row, 'Project Number')} — Reference\n\n` +
    `## Project reference\n${table(['Field', 'Value'], [
      ['Client / Contact', `${val(row, 'Client')} / ${val(row, 'Client Contact')}`],
      ['Producer / CD', `${val(row, 'Producer')} / ${val(row, 'Creative Director')}`],
      ['Delivery Date', val(row, 'End Date')], ['VO', val(row, 'VO')], ['Music', val(row, 'Music')],
    ])}\n\n## Project specs\n${table(['Spec', 'Value'], [
      ['Dimensions', s.Dimensions], ['Frame Rate', s['Frame Rate']], ['Duration', s.Duration],
      ['Audio', s['Audio Requirements']], ['File Type', s['Primary File Type']], ['Notes', s.Notes], ['Confirmation', s['Specs Status']],
    ])}\n\n## Delivery files\n${table(['Deliverable', 'Specs', 'Status', 'Link'], extra.deliverables.map((d) => [d.Deliverable, d.Specs, d.Status, link('Open', d['Delivery Link'])]))}`
}

function statusLabel(status: string): string {
  if (status === 'Complete') return '✅ Complete'
  if (status === 'In Progress') return '🟢 **IN PROGRESS**'
  if (status === 'Client Review') return '🟡 Client Review'
  if (status === 'Blocked') return '🔴 Blocked'
  return '⚪ Not Started'
}

export function renderScheduleView(row: NormalizedRow, extra: ProjectSupplement): string {
  const ordered = [...extra.workback].sort((a, b) => Number(a['Sort Order'] || 0) - Number(b['Sort Order'] || 0))
  const rows = ordered.filter((x) => x['Show on Canvas'] !== 'FALSE').map((w) => {
    const complete = w.Status === 'Complete'
    const task = complete ? `~~${w.Task}~~` : w.Status === 'In Progress' ? `**${w.Task}**` : w.Task
    return [task, `${w['Start Date']} → ${w['Due Date']}`, w.Owner, statusLabel(w.Status)]
  })
  return `${GENERATED_VIEW_NOTICE}\n\n# ${val(row, 'Project Number')} — Schedule\n\n` +
    `**Schedule status:** ${extra.scheduleStatus || 'Draft'}  \n` +
    `**Project window:** ${val(row, 'Start Date')} → ${val(row, 'End Date')}\n\n` +
    table(['Milestone', 'Date Range', 'Owner', 'Status'], rows)
}
