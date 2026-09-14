const ymdDate = (value: string) => new Date(`${value}T12:00:00Z`)
const toYmd = (date: Date) => date.toISOString().slice(0, 10)
const ymdAddDays = (value: string, days: number) => toYmd(new Date(ymdDate(value).getTime() + days * 86400000))

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
