import { createHash } from 'node:crypto'

export function checkinIntentKey(input: {
  checkinId: string; origin: string | null; staffId: string; harvestUserId: number
  project: number; task: number; date: string; hours: number; notes: string
}): string {
  const entry = { project: input.project, task: input.task, date: input.date, hours: input.hours, notes: input.notes }
  // Preserve scheduled markers exactly, including pre-deploy in-flight rows.
  if (input.origin !== 'adhoc') return `${input.checkinId}:${createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16)}`
  return `adhoc-v2:${createHash('sha256').update(JSON.stringify({ ...entry,
    notes: input.notes.trim().replace(/\s+/g, ' '), staff: input.staffId, user: input.harvestUserId,
  })).digest('hex')}`
}
