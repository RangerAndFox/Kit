/**
 * Current-date context for the LLM.
 *
 * The orchestrator and specialists otherwise run with a static system prompt
 * and no notion of "now", so any relative date ("yesterday", "last Thursday")
 * left them stuck — the model would ask the user what today's date is. This
 * one line, injected as its own (uncached) system block, gives Kit the anchor
 * to resolve relative dates itself. Rendered in the studio check-in timezone
 * so it agrees with how the rest of Kit computes "today".
 */

import { checkinTimezone } from '../checkins/date'

export function currentDateLine(now: Date = new Date()): string {
  const tz = checkinTimezone()
  const full = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now)
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  return `Current date: ${full} (${iso}), studio timezone ${tz}. Resolve relative dates like "today", "yesterday", or "last Thursday" from this yourself — never ask the user what today's date is.`
}
