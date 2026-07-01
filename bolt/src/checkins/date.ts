/**
 * Check-in date helpers.
 *
 * The daily-hours cron fires in CHECKIN_TIMEZONE (5pm/10pm Pacific by default),
 * but "what day is it" must be computed in that same timezone — NOT UTC. At
 * 5pm Pacific the UTC calendar date is already tomorrow, so a UTC-derived
 * check_in_date (and the Harvest spent_date that follows it) lands a day ahead.
 * Everything that derives the check-in's date goes through here.
 */

/** The studio check-in timezone (CHECKIN_TIMEZONE, default America/Los_Angeles). */
export function checkinTimezone(): string {
  return process.env.CHECKIN_TIMEZONE || 'America/Los_Angeles'
}

/** Today as YYYY-MM-DD in the check-in timezone. */
export function checkinToday(now: Date = new Date(), tz: string = checkinTimezone()): string {
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/**
 * N days before today (YYYY-MM-DD), anchored to the check-in timezone's
 * calendar date so DST shifts can't drift the result.
 */
export function checkinDateMinusDays(
  days: number,
  now: Date = new Date(),
  tz: string = checkinTimezone(),
): string {
  const [y, m, d] = checkinToday(now, tz).split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d, 12)) // noon UTC — safe from ± shifts
  base.setUTCDate(base.getUTCDate() - days)
  return base.toISOString().split('T')[0]
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

/**
 * Validate a parser-proposed spent date against the check-in's anchor day.
 * Hours can't be logged to the future, and a date more than ~2 weeks back is
 * almost certainly a misparse — both fall back to the anchor. Keeps a bad LLM
 * guess from silently writing Harvest time to the wrong day.
 */
export function resolveSpentDate(
  proposed: string | null | undefined,
  anchorYmd: string,
): string {
  if (!proposed || !YMD_RE.test(proposed)) return anchorYmd
  const p = Date.parse(`${proposed}T12:00:00Z`)
  const a = Date.parse(`${anchorYmd}T12:00:00Z`)
  if (Number.isNaN(p) || Number.isNaN(a)) return anchorYmd
  if (p > a) return anchorYmd // no future-dating
  if (p < a - 14 * DAY_MS) return anchorYmd // too far back to trust
  return proposed
}

/** "Tue Jun 24" for a YYYY-MM-DD, rendered in the check-in timezone. */
export function formatShortDate(ymd: string, tz: string = checkinTimezone()): string {
  if (!YMD_RE.test(ymd)) return ymd
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${ymd}T12:00:00Z`))
}

/** Shift a YYYY-MM-DD by N calendar days (negative = back). */
export function ymdAddDays(ymd: string, n: number): string {
  const base = new Date(`${ymd}T12:00:00Z`)
  base.setUTCDate(base.getUTCDate() + n)
  return base.toISOString().split('T')[0]
}

/** True when a YYYY-MM-DD falls Mon–Fri in the given timezone. */
export function isWorkday(ymd: string, tz: string = checkinTimezone()): boolean {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(
    new Date(`${ymd}T12:00:00Z`),
  )
  return wd !== 'Sat' && wd !== 'Sun'
}
