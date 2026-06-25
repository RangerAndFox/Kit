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
