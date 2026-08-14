/**
 * Check-in recovery helpers (pure, unit-tested).
 *
 * Support for `scripts/recover-stuck-checkins.ts`. These exist as their own
 * module — rather than inline in the script — because the two defects that
 * corrupted Harvest data were both in this logic, and pure functions are the
 * only part of the recovery path that can be tested without Slack/Harvest.
 *
 * Defect 1 (over-capture): the reply search joined EVERY message between a
 * stuck check-in and the next one. When check-ins were days apart that swept
 * up later days' answers, so one check-in ingested another day's hours.
 * `extractReplyBurst` fixes this: the SEARCH window stays wide (people answer
 * a check-in a day or more late, and a tight window found nothing), but only
 * the first contiguous burst of messages is taken as the reply.
 *
 * Defect 2 (unvalidated write): a hallucinated parse produced duplicated and
 * inflated entries that were written without a sanity check.
 * `validateEntries` refuses obviously-wrong sets before anything is logged.
 */

/** The subset of a Slack message this module needs. */
export interface SlackMessageLike {
  ts: string
  user?: string
  bot_id?: string
  subtype?: string
  text?: string
}

export interface ReplyBurst {
  text: string
  /** ts of the burst's first message — the reply the check-in is answered by. */
  ts: string
  /** How many messages were joined into `text`. */
  messageCount: number
  /** Messages inside the search window that were left out (a later burst). */
  excludedCount: number
}

/** Default gap that ends a burst. Consecutive lines of one answer arrive fast. */
export const DEFAULT_BURST_GAP_MINUTES = 30

/**
 * Take the user's FIRST contiguous burst of messages as their reply.
 *
 * `messages` may be in any order (Slack returns newest-first). Bot messages
 * and system subtypes are ignored. Messages after a gap larger than
 * `burstGapMinutes` belong to a later conversation — typically the answer to a
 * DIFFERENT day's check-in — and are excluded, which is what keeps one day's
 * hours from being logged onto another day.
 */
export function extractReplyBurst(
  messages: SlackMessageLike[],
  slackUserId: string,
  opts: { burstGapMinutes?: number } = {},
): ReplyBurst | null {
  const gapSeconds = (opts.burstGapMinutes ?? DEFAULT_BURST_GAP_MINUTES) * 60
  const mine = (messages || [])
    .filter(
      (m) =>
        m &&
        m.user === slackUserId &&
        !m.bot_id &&
        !m.subtype &&
        typeof m.text === 'string' &&
        m.text.trim() !== '',
    )
    .sort((a, b) => Number(a.ts) - Number(b.ts))

  if (mine.length === 0) return null

  const burst: SlackMessageLike[] = [mine[0]]
  for (let i = 1; i < mine.length; i++) {
    if (Number(mine[i].ts) - Number(mine[i - 1].ts) > gapSeconds) break
    burst.push(mine[i])
  }

  return {
    text: burst.map((m) => (m.text as string).trim()).join('\n'),
    ts: burst[0].ts,
    messageCount: burst.length,
    excludedCount: mine.length - burst.length,
  }
}

/** A resolved entry, as produced by the preview and written by the commit. */
export interface PlannedEntry {
  hours: number
  spentDate?: string
  notes?: string
  projectQuery: string
  resolution: 'matched' | 'ambiguous' | 'unmatched'
  harvest_project_id?: number
  harvest_project_name?: string
}

/** A day's total above this is a misparse, not a workday. */
export const DEFAULT_MAX_TOTAL_HOURS = 16

/**
 * Refuse entry sets that cannot be a single person's single day.
 *
 * Every check here corresponds to something an LLM misparse actually produced
 * against production data: unmatched project names, ~25h and ~60h day totals,
 * and the same (project, hours) pair repeated verbatim.
 */
export function validateEntries(
  entries: PlannedEntry[],
  opts: { maxTotalHours?: number; allowDuplicates?: boolean } = {},
): { ok: boolean; problems: string[]; totalHours: number } {
  const maxTotal = opts.maxTotalHours ?? DEFAULT_MAX_TOTAL_HOURS
  const problems: string[] = []

  if (!entries || entries.length === 0) {
    return { ok: false, problems: ['no entries'], totalHours: 0 }
  }

  let totalHours = 0
  for (const e of entries) {
    const h = Number(e.hours)
    if (!Number.isFinite(h) || h <= 0) {
      problems.push(`invalid hours (${e.hours}) for "${e.projectQuery}"`)
      continue
    }
    totalHours += h
    if (e.resolution !== 'matched' || !e.harvest_project_id) {
      problems.push(`unresolved project "${e.projectQuery}" (${e.resolution})`)
    }
  }

  totalHours = Math.round(totalHours * 1000) / 1000
  if (totalHours > maxTotal) {
    problems.push(`total ${totalHours}h exceeds the ${maxTotal}h single-day limit`)
  }

  if (!opts.allowDuplicates) {
    const seen = new Set<string>()
    for (const e of entries) {
      const key = `${e.harvest_project_id ?? e.projectQuery}|${e.hours}|${e.spentDate ?? ''}`
      if (seen.has(key)) {
        problems.push(
          `duplicate entry ${e.hours}h → ${e.harvest_project_name || e.projectQuery}` +
            `${e.spentDate ? ` on ${e.spentDate}` : ''}`,
        )
      }
      seen.add(key)
    }
  }

  return { ok: problems.length === 0, problems, totalHours }
}
