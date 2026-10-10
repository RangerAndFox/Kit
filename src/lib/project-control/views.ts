import { createHash } from 'node:crypto'
import { GENERATED_VIEW_NOTICE, parseDateToSerial, type NormalizedRow } from './render'
import { TEAM_ASSET_TYPES, assetTypeKey, teamAssetLinks } from './assets'

export interface ProjectSupplement {
  scheduleStatus?: string
  specs: Record<string, string>
  workback: Array<Record<string, string>>
  links: Array<Record<string, string>>
  deliverables: Array<Record<string, string>>
  assignments: Array<Record<string, string>>
  statusLog?: Array<Record<string, string>>
}

// Bump when generated Canvas markup changes so the sync cursor performs one
// complete regeneration even if the workbook itself has not changed.
export const PROJECT_VIEW_RENDER_VERSION = '12'
export const PROJECT_CONTROL_TIMEZONE = 'America/Los_Angeles'

/** Calendar date, not a UTC day or a fixed PST offset (Pacific observes DST). */
export function projectControlDay(instant = new Date().toISOString()): string | null {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PROJECT_CONTROL_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const value = (type: string) => parts.find(part => part.type === type)?.value
  return `${value('year')}-${value('month')}-${value('day')}`
}

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

export function projectViewHash(row: NormalizedRow, extra: ProjectSupplement, assignmentDay = projectControlDay()): string {
  // Only assignment-bearing projects depend on the local day. Minute-by-minute
  // clock changes and projects without assignments must not cause Slack writes.
  return createHash('sha256').update(JSON.stringify({ renderVersion: PROJECT_VIEW_RENDER_VERSION, row, extra,
    assignmentDay: extra.assignments.length ? assignmentDay : null,
  })).digest('hex')
}

export function renderOverviewView(row: NormalizedRow, extra: ProjectSupplement, syncedAt = new Date().toISOString(), refreshUrl?: string | null, assignmentDay = projectControlDay(syncedAt)): string {
  // This is the time of the rendered snapshot, not a heartbeat. It stays out
  // of the source hash so unchanged polls do not repeatedly edit Slack.
  const timestamp = new Date(syncedAt)
  const lastSynced = Number.isNaN(timestamp.getTime()) ? 'Unavailable' : new Intl.DateTimeFormat('en-US', {
    timeZone: PROJECT_CONTROL_TIMEZONE, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(timestamp)
  const assignments = extra.assignments.filter((a) => assignmentDay !== null && a.Date === assignmentDay)
  const assignmentRows = assignments.length > 0
    ? assignments.map((a) => [a.Person, a['Daily Assignment']])
    : [['—', 'No assignments for today']]
  const assetTypes = [...TEAM_ASSET_TYPES]
  const links = teamAssetLinks(extra.links)
  // Optional supported assets add a row automatically, without duplicating
  // the fixed template rows or leaking arbitrary Other/financial links.
  if (links.some(entry => assetTypeKey(entry['Link Type']) === 'onedrive')) assetTypes.splice(1, 0, 'OneDrive')
  const assetRows = assetTypes.flatMap(type => {
    const entries = links.filter(entry => assetTypeKey(entry['Link Type']) === assetTypeKey(type))
    return entries.length ? entries.map(entry => [type, link(type, entry.URL)]) : [[type, '—']]
  })
  const refresh = refreshUrl && /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+$/i.test(refreshUrl)
    ? ` · [Refresh this project](${refreshUrl})` : ''
  return `**Last synced:** ${lastSynced}${refresh}\n\n` +
    `## Today’s assignments\n${table(['Artist', 'Assignment'], assignmentRows)}\n\n` +
    `## Project Status\n${table(['Field', 'Value'], [['Last Share', row['Last Share']?.hyperlink ? link(row['Last Share'].display, row['Last Share'].hyperlink) : val(row, 'Last Share')], ['Status', val(row, 'Quick Status')], ['Next Milestone', val(row, 'Next Share')]])}\n\n` +
    `## Asset folders\n${table(['Asset', 'Link'], assetRows)}`
}

export function renderReferenceView(row: NormalizedRow, extra: ProjectSupplement): string {
  const s = extra.specs
  return `${GENERATED_VIEW_NOTICE}\n\n# ${val(row, 'Project Number')} — Reference\n\n` +
    `## Project reference\n${table(['Field', 'Value'], [
      // Client contacts stay in the producer-controlled Sheet. Project-channel
      // canvases can include artists, so the projection intentionally omits it.
      ['Client', val(row, 'Client')],
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

function scheduleDate(value?: string): number | null {
  const text = value?.trim() || ''
  // Real Sheet dates arrive as ISO; pasted US dates can arrive as display text.
  // Reuse the strict calendar validator rather than permissive Date.parse.
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  return parseDateToSerial(us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : text)
}

export function renderScheduleView(row: NormalizedRow, extra: ProjectSupplement): string {
  const last = Number.MAX_SAFE_INTEGER
  const ordered = extra.workback.map(w => {
    const start = scheduleDate(w['Start Date'])
    const due = scheduleDate(w['Due Date'])
    const order = w['Sort Order']?.trim()
    return { w, start: start ?? due ?? last, due: due ?? start ?? last,
      order: order && Number.isFinite(Number(order)) ? Number(order) : last }
  }).sort((a, b) => a.start - b.start || a.due - b.due || a.order - b.order).map(({ w }) => w)
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

export function renderNotesAndFeedbackView(row: NormalizedRow, extra: ProjectSupplement): string {
  const rows = [...(extra.statusLog || [])]
    // Fail closed: this Canvas is visible to the project team, while the
    // workbook may contain producer-only free text. Only an explicit Team
    // classification is projected; blank/private rows never leave the Sheet.
    .filter((entry) => String(entry.Visibility || '').trim().toLowerCase() === 'team')
    .sort((a, b) => String(b.Date || '').localeCompare(String(a.Date || '')))
    .map((entry) => [entry.Date, entry.Update, entry['Updated By']])
  return `> ✏️ **Team workspace — edit this canvas directly.**\n` +
    `> Kit will not overwrite content added here. Keep budgets, client contacts, and other sensitive information in producer-only systems.\n\n` +
    `# ${val(row, 'Project Number')} — Notes & Feedback\n\n` +
    `Kit seeded the team-safe project log below. Add ongoing notes and feedback anywhere in this canvas.\n\n` +
    table(['Date', 'Update', 'Updated By'], rows.length > 0 ? rows : [['—', 'No notes or feedback yet', '—']])
}
