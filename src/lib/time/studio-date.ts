/**
 * Studio-timezone calendar dates.
 *
 * "Today" must be computed in the studio's timezone, never UTC: at 5pm
 * Pacific the UTC calendar date is already tomorrow, so a UTC-derived
 * default landed evening time entries on the next day. Anything that
 * stamps a YYYY-MM-DD "today" (Harvest spent_date defaults, relative-day
 * resolution) goes through here. Mirrors bolt/src/checkins/date.ts, which
 * anchors the check-in flow the same way.
 */

export function studioTimezone(): string {
  return process.env.STUDIO_TIMEZONE || process.env.CHECKIN_TIMEZONE || 'America/Los_Angeles'
}

/** Today as YYYY-MM-DD in the studio timezone. */
export function studioToday(now: Date = new Date(), tz: string = studioTimezone()): string {
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/**
 * N days before today (YYYY-MM-DD), anchored to the studio timezone's
 * calendar date so DST shifts can't drift the result.
 */
export function studioDateMinusDays(
  days: number,
  now: Date = new Date(),
  tz: string = studioTimezone(),
): string {
  const [y, m, d] = studioToday(now, tz).split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d, 12)) // noon UTC — safe from ± shifts
  base.setUTCDate(base.getUTCDate() - days)
  return base.toISOString().split('T')[0]
}
