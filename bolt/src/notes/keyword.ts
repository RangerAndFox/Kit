// @ts-nocheck
/**
 * Detect note-capture intent in @Kit messages.
 *
 * Patterns (case-insensitive):
 *   - "note for [project]: [body]"
 *   - "note: [body]"
 *   - "remember [body] for [project]"
 *   - "remember that [body]"
 *   - "remember [body]"
 *
 * Returns null if no note intent detected, or { projectHint, body } otherwise.
 * projectHint may be null when the user implies "this channel's project".
 */

export interface NoteIntent {
  body: string
  projectHint: string | null
}

const RE_NOTE_FOR = /^\s*note\s+for\s+([^:]+?)\s*:\s*([\s\S]+)$/i
const RE_NOTE = /^\s*note\s*:\s*([\s\S]+)$/i
const RE_REMEMBER_FOR = /^\s*remember\s+(?:that\s+)?([\s\S]+?)\s+for\s+(.+)$/i
const RE_REMEMBER = /^\s*remember\s+(?:that\s+)?([\s\S]+)$/i

export function parseNoteIntent(text: string): NoteIntent | null {
  if (!text || text.length < 5) return null
  const cleaned = text.trim()

  const noteFor = cleaned.match(RE_NOTE_FOR)
  if (noteFor) {
    return { projectHint: noteFor[1].trim(), body: noteFor[2].trim() }
  }

  const note = cleaned.match(RE_NOTE)
  if (note) {
    return { projectHint: null, body: note[1].trim() }
  }

  const rememberFor = cleaned.match(RE_REMEMBER_FOR)
  if (rememberFor) {
    return { projectHint: rememberFor[2].trim(), body: rememberFor[1].trim() }
  }

  const remember = cleaned.match(RE_REMEMBER)
  if (remember) {
    return { projectHint: null, body: remember[1].trim() }
  }

  return null
}

export function isNoteTrigger(text: string): boolean {
  return parseNoteIntent(text) !== null
}
