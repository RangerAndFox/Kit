// @ts-nocheck
/**
 * Casual Time Entry Parser
 *
 * Detects natural-language time logging in Slack messages.
 * Examples it catches:
 *   "spent 3 hours on the NRG project"
 *   "worked 2.5h on brand video today"
 *   "logged 4 hours NRG"
 *   "put in 6 hours on the explainer"
 *   "did 1.5 hrs on the campaign"
 *   "3 hours on NRG today"
 *   "half hour on the pitch deck"
 */

import { studioToday, studioDateMinusDays } from '../time/studio-date'

export interface ParsedTimeEntry {
  hours: number
  projectHint: string | null  // whatever text we think is the project name
  date: string | null         // "today", "yesterday", or null
  notes: string | null        // the original message as context
}

// Patterns that indicate someone is logging time
const TIME_PATTERNS = [
  // "spent X hours on ..."
  /(?:spent|worked|logged|put in|did)\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s+(?:on\s+)?(?:the\s+)?(.+)/i,
  // "X hours on ..."
  /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s+(?:on\s+)?(?:the\s+)?(.+)/i,
  // "half hour on ..."
  /(?:a\s+)?half\s*(?:an?\s+)?(?:hour|hr)\s+(?:on\s+)?(?:the\s+)?(.+)/i,
  // "quarter hour on ..."
  /(?:a\s+)?quarter\s*(?:of\s+an?\s+)?(?:hour|hr)\s+(?:on\s+)?(?:the\s+)?(.+)/i,
  // "spent X.X on ..." (hours implied)
  /(?:spent|worked|logged|put in|did)\s+(\d+(?:\.\d+)?)\s+(?:on\s+)?(?:the\s+)?(.+)/i,
]

// Words that indicate this is NOT a time entry (false positive filter)
const FALSE_POSITIVE_WORDS = [
  'meeting', 'standup', 'call', 'lunch', 'break', 'minutes ago',
  'hours ago', 'days ago', 'in 2 hours', 'at 3', 'by 5',
  'deadline', 'due in', 'takes about',
]

/**
 * Try to parse a casual time entry from a message.
 * Returns null if the message doesn't look like a time entry.
 */
export function parseTimeEntry(text: string): ParsedTimeEntry | null {
  // Strip Slack user mentions and channel refs
  const cleaned = text
    .replace(/<@[A-Z0-9]+>/g, '')
    .replace(/<#[A-Z0-9]+\|[^>]+>/g, '')
    .trim()

  // Check for false positives
  const lower = cleaned.toLowerCase()
  if (FALSE_POSITIVE_WORDS.some((w) => lower.includes(w))) {
    return null
  }

  // Try each pattern
  for (const pattern of TIME_PATTERNS) {
    const match = cleaned.match(pattern)
    if (!match) continue

    let hours: number
    let projectHint: string | null

    if (pattern === TIME_PATTERNS[2]) {
      // "half hour" pattern — no number capture group
      hours = 0.5
      projectHint = match[1] || null
    } else if (pattern === TIME_PATTERNS[3]) {
      // "quarter hour" pattern
      hours = 0.25
      projectHint = match[1] || null
    } else {
      hours = parseFloat(match[1])
      projectHint = match[2] || null
    }

    // Sanity check hours
    if (hours <= 0 || hours > 24) continue

    // Clean up the project hint
    if (projectHint) {
      projectHint = cleanProjectHint(projectHint)
    }

    // Check for date references
    let date: string | null = null
    if (lower.includes('today')) date = 'today'
    else if (lower.includes('yesterday')) date = 'yesterday'

    return {
      hours,
      projectHint,
      date,
      notes: cleaned,
    }
  }

  return null
}

/**
 * Clean up extracted project hint text.
 * Strips trailing date references, punctuation, etc.
 */
function cleanProjectHint(hint: string): string {
  return hint
    .replace(/\s*(today|yesterday|this morning|this afternoon)\s*/gi, '')
    .replace(/[.!?,;:]+$/, '')  // trailing punctuation
    .replace(/\s+$/, '')
    .trim()
}

/**
 * Resolve "today" / "yesterday" / null to YYYY-MM-DD in the studio
 * timezone — a UTC-derived date is already tomorrow by 5pm Pacific.
 */
export function resolveDate(dateHint: string | null): string {
  if (dateHint === 'yesterday') return studioDateMinusDays(1)
  return studioToday()
}
