import { createHash } from 'node:crypto'
import { z } from 'zod'

export const SPEC_HEADERS = ['Project ID', 'Dimensions', 'Frame Rate', 'Duration', 'Audio Requirements', 'Primary File Type', 'Notes', 'Specs Status'] as const
export const specEditSchema = z.object({
  dimensions: z.string().trim().regex(/^\d{2,5}\s*[x×]\s*\d{2,5}$/i, 'Enter exact pixels, e.g. 3840 x 2160; “4K” is ambiguous.'),
  frameRate: z.string().trim().regex(/^\d{1,3}(?:\.\d{1,3})?$/, 'Enter a number such as 24 or 23.976.').refine(v => Number(v) > 0 && Number(v) <= 240, 'Frame rate must be between 0 and 240.'),
  duration: z.string().trim().max(80),
  audio: z.string().trim().max(160),
  fileType: z.string().trim().max(80),
  notes: z.string().trim().max(250),
}).strict()
export type SpecEdit = z.infer<typeof specEditSchema>
export interface SpecSnapshot { projectNumber: string; rowIndex: number; values: string[]; hash: string }
export function specHash(values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}
export function specValues(projectNumber: string, edit: SpecEdit): string[] {
  return [projectNumber, edit.dimensions, edit.frameRate, edit.duration, edit.audio, edit.fileType, edit.notes, 'Confirmed']
}
export function approvedSpecReply(snapshot: SpecSnapshot, artist: boolean): string {
  const values = snapshot.values
  const confirmed = /^(approved|confirmed|final)$/i.test(values[7]?.trim() || '')
  if (artist && !confirmed) return 'No approved specs are recorded for this project yet. Ask the producer or CD to confirm them. Chat notes are not approved production specs.'
  // Deliberate allowlist; never include the freeform Notes field or project data.
  return `${confirmed ? 'Approved' : 'Unconfirmed'} project specs — ${snapshot.projectNumber}\n` +
    SPEC_HEADERS.slice(1, 6).map((label, i) => `${label}: ${values[i + 1] || 'Not specified'}`).join('\n') +
    '\nSource: Production Control Center → Specs. Remembered notes do not change these values.'
}
