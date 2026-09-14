export const OFFBOARD_METADATA_KEY = 'kit_artist_offboarded'
export type AssignmentExclusion = {engagementId:string;projectNumber:string;person:string;lastWorkingDate:string}
export function parseExclusion(value: string): AssignmentExclusion {
  const row = JSON.parse(value) as AssignmentExclusion
  if (!row || !row.engagementId || !row.projectNumber || !row.person || !/^\d{4}-\d{2}-\d{2}$/.test(row.lastWorkingDate)) throw new Error('Invalid artist assignment exclusion')
  return row
}
export const personKey = (name: string) => name.trim().replace(/\s+/g,' ').toLowerCase()
export function assignmentDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  return match ? `${match[3]}-${match[1].padStart(2,'0')}-${match[2].padStart(2,'0')}` : null
}
export function projectAssignmentView(rows: Array<Record<string,string>>, exclusions: AssignmentExclusion[]): Array<Record<string,string>> {
  return rows.map(row => {
    const exclusion=exclusions.find(e=>e.projectNumber===row['Project ID'] && personKey(e.person)===personKey(row.Person || ''))
    if (!exclusion) return row
    const date=assignmentDate(row.Date || '')
    if (date && date<=exclusion.lastWorkingDate) return row
    // Preserve original sheet/history; make reassignment explicit in the view.
    return {...row,Person:'Unassigned', 'Daily Assignment':`[Needs reassignment] ${row['Daily Assignment'] || ''}`}
  })
}
