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

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
}

/** Pick the year (this or last) that puts month/day on-or-before the anchor. */
function resolveMonthDay(month1: number, day: number, anchorYmd: string): string | null {
  if (month1 < 1 || month1 > 12 || day < 1 || day > 31) return null
  const anchorMs = Date.parse(`${anchorYmd}T12:00:00Z`)
  const anchorYear = Number(anchorYmd.slice(0, 4))
  for (const y of [anchorYear, anchorYear - 1]) {
    const cand = `${y}-${String(month1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const ms = Date.parse(`${cand}T12:00:00Z`)
    // Reject invalid calendar dates (Date.parse normalizes, so re-check).
    if (Number.isNaN(ms) || cand !== toYmd(new Date(ms))) continue
    if (ms <= anchorMs) return cand
  }
  return null
}

/**
 * Resolve a human day reference to a YYYY-MM-DD relative to the anchor day,
 * deterministically (NOT via the LLM — models are unreliable at "what date
 * was Monday?"). Handles: ISO dates, today/yesterday, "N days ago", weekday
 * names ("monday", "last tuesday" → the most recent past occurrence), and
 * month/day ("june 20", "6/20"). Returns null for anything unrecognized, so
 * the caller falls back to the anchor day. Backfilling only reaches back a
 * few days in practice; resolveSpentDate() still guards the final value.
 */
export function resolveDayPhrase(
  phrase: string | null | undefined,
  anchorYmd: string,
): string | null {
  if (!phrase) return null
  const s = String(phrase).trim().toLowerCase().replace(/[.,]/g, '').trim()
  if (!s) return null
  if (YMD_RE.test(s)) return s

  if (s === 'today' || s === 'tonight' || s === 'tod') return anchorYmd
  if (s === 'yesterday' || s === 'yday' || s === 'yest') return ymdAddDays(anchorYmd, -1)
  if (s === 'day before yesterday' || s === 'the day before yesterday') {
    return ymdAddDays(anchorYmd, -2)
  }

  const ago = s.match(/^(\d+)\s+days?\s+ago$/)
  if (ago) return ymdAddDays(anchorYmd, -Number(ago[1]))

  // Weekday, optionally prefixed by on/last/this/past. "last <weekday>" that
  // lands on the anchor's own weekday means the prior week.
  const hadLast = /\blast\b/.test(s)
  const wdKey = s.replace(/^(?:on\s+|last\s+|this\s+|past\s+)+/, '').replace(/\s+/g, '')
  if (wdKey in WEEKDAYS) {
    const anchorDow = ymdDate(anchorYmd).getUTCDay()
    let delta = (anchorDow - WEEKDAYS[wdKey] + 7) % 7
    if (delta === 0 && hadLast) delta = 7
    return ymdAddDays(anchorYmd, -delta)
  }

  // Month + day in either order: "june 20" / "20 june".
  const cleaned = s.replace(/^on\s+/, '').replace(/(\d+)(?:st|nd|rd|th)\b/, '$1')
  let m = cleaned.match(/^([a-z]+)\s+(\d{1,2})$/)
  if (m && m[1] in MONTHS) return resolveMonthDay(MONTHS[m[1]], Number(m[2]), anchorYmd)
  m = cleaned.match(/^(\d{1,2})\s+([a-z]+)$/)
  if (m && m[2] in MONTHS) return resolveMonthDay(MONTHS[m[2]], Number(m[1]), anchorYmd)

  // Numeric month/day: "6/20" or "6-20" (no year).
  m = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})$/)
  if (m) return resolveMonthDay(Number(m[1]), Number(m[2]), anchorYmd)

  return null
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
