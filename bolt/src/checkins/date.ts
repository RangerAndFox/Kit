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

// ─── Holidays ───────────────────────────────────────────────
// Without holiday awareness, a 3-day studio closure (e.g. Thanksgiving week)
// counted as three "missing" working days and false-flagged everyone.

/** UTC-noon Date for a YMD (avoids DST edges in day-of-week math). */
function ymdDate(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`)
}

function toYmd(d: Date): string {
  return d.toISOString().split('T')[0]
}

/** The Nth <weekday> (0=Sun..6=Sat) of a month, as YYYY-MM-DD. */
function nthWeekday(year: number, month1: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month1 - 1, 1, 12))
  const offset = (weekday - first.getUTCDay() + 7) % 7
  return toYmd(new Date(Date.UTC(year, month1 - 1, 1 + offset + (n - 1) * 7, 12)))
}

/** The last <weekday> of a month, as YYYY-MM-DD. */
function lastWeekday(year: number, month1: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month1, 0, 12)) // day 0 of next month
  const offset = (last.getUTCDay() - weekday + 7) % 7
  return toYmd(new Date(Date.UTC(year, month1, -offset, 12)))
}

/** Shift a fixed-date holiday to its observed day (Sat→Fri, Sun→Mon). */
function observed(ymd: string): string {
  const dow = ymdDate(ymd).getUTCDay()
  if (dow === 6) return ymdAddDays(ymd, -1)
  if (dow === 0) return ymdAddDays(ymd, 1)
  return ymd
}

const holidayCache = new Map<number, Set<string>>()

/**
 * US studio holidays for a year: federal holidays a production studio
 * actually closes for, plus the day after Thanksgiving. Extend or override
 * with STUDIO_HOLIDAYS (comma-separated YYYY-MM-DD) for one-off closures.
 */
export function studioHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year)
  if (cached) return cached
  const thanksgiving = nthWeekday(year, 11, 4, 4)
  const set = new Set<string>([
    observed(`${year}-01-01`), // New Year's Day
    nthWeekday(year, 1, 1, 3), // MLK Day
    nthWeekday(year, 2, 1, 3), // Presidents Day
    lastWeekday(year, 5, 1), // Memorial Day
    observed(`${year}-06-19`), // Juneteenth
    observed(`${year}-07-04`), // Independence Day
    nthWeekday(year, 9, 1, 1), // Labor Day
    thanksgiving,
    ymdAddDays(thanksgiving, 1), // day after Thanksgiving
    observed(`${year}-12-25`), // Christmas
  ])
  holidayCache.set(year, set)
  return set
}

/** True when the date is a studio holiday (computed US set + env overrides). */
export function isStudioHoliday(ymd: string): boolean {
  const year = Number(ymd.slice(0, 4))
  if (studioHolidays(year).has(ymd)) return true
  const extra = (process.env.STUDIO_HOLIDAYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return extra.includes(ymd)
}

/** True when a YYYY-MM-DD falls Mon–Fri in the given timezone AND isn't a studio holiday. */
export function isWorkday(ymd: string, tz: string = checkinTimezone()): boolean {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(
    ymdDate(ymd),
  )
  if (wd === 'Sat' || wd === 'Sun') return false
  return !isStudioHoliday(ymd)
}
