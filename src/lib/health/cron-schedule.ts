/**
 * Timezone- and DST-aware schedule math for cron freshness.
 *
 * The health watchdog runs on Vercel but must reason about crons that fire on a
 * wall-clock schedule in a studio timezone (e.g. "09:00 America/Los_Angeles,
 * weekdays only"). A naive "last success older than N minutes" check false-reds
 * such a cron every weekend and every night. These helpers compute the most
 * recent instant a scheduled cron was *expected* to fire, correctly across DST
 * transitions and weekends, using only `Intl` (no dependency).
 *
 * All functions are pure and deterministic given (now, tz).
 */

export interface IntervalSpec {
  kind: 'interval'
  label: string
  /** Success older than this many minutes is stale. */
  maxAgeMin: number
  /** When present and false for the current env, the cron is not checked. */
  enabled?: (env: Record<string, string | undefined>) => boolean
}

export interface DailySpec {
  kind: 'daily'
  label: string
  /** Local hour (0-23) and minute the cron fires at, in `tz`. */
  hour: number
  minute: number
  /** IANA timezone the wall-clock schedule is expressed in. */
  tz: string
  /** Allowed weekdays, 0=Sun..6=Sat. Omit for every day. */
  days?: number[]
  /** How long after a scheduled fire the cron may still be "catching up". */
  graceMin: number
  enabled?: (env: Record<string, string | undefined>) => boolean
}

export type CronSpec = IntervalSpec | DailySpec

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

/** Offset (localWallClock - UTC) in ms at instant `d` for timezone `tz`. */
export function tzOffsetMs(d: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(d)) if (p.type !== 'literal') m[p.type] = p.value
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second)
  return asUTC - d.getTime()
}

/** The UTC instant of a wall-clock time (year, month 1-12, day, hour, minute) in `tz`. */
export function zonedTimeToUtc(
  year: number, month: number, day: number, hour: number, minute: number, tz: string,
): Date {
  const naiveUTC = Date.UTC(year, month - 1, day, hour, minute, 0)
  // Guess the offset at the naive instant, then refine once so a DST boundary
  // between the guess and the real instant is corrected.
  const guess = tzOffsetMs(new Date(naiveUTC), tz)
  let utc = naiveUTC - guess
  const refined = tzOffsetMs(new Date(utc), tz)
  if (refined !== guess) utc = naiveUTC - refined
  return new Date(utc)
}

/** Local calendar parts of instant `d` in `tz`, with weekday as 0=Sun..6=Sat. */
export function zonedParts(d: Date, tz: string): {
  year: number; month: number; day: number; hour: number; minute: number; weekday: number
} {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(d)) if (p.type !== 'literal') m[p.type] = p.value
  return {
    year: +m.year, month: +m.month, day: +m.day, hour: +m.hour, minute: +m.minute,
    weekday: WEEKDAY_INDEX[m.weekday] ?? 0,
  }
}

/**
 * The most recent instant on or before `now` at which a daily/weekday cron was
 * expected to fire, or null if none in the last 8 days (defensive; a daily cron
 * always has one). Weekday filtering uses the *local* calendar date, and the
 * wall-clock fire time is converted to UTC with DST correctness.
 */
export function mostRecentScheduledFire(spec: DailySpec, now: Date): Date | null {
  const today = zonedParts(now, spec.tz)
  // Walk back over local calendar dates (DST-immune: date-only UTC arithmetic).
  for (let back = 0; back <= 8; back++) {
    const cal = new Date(Date.UTC(today.year, today.month - 1, today.day))
    cal.setUTCDate(cal.getUTCDate() - back)
    const y = cal.getUTCFullYear(), mo = cal.getUTCMonth() + 1, d = cal.getUTCDate()
    const weekday = cal.getUTCDay()
    if (spec.days && !spec.days.includes(weekday)) continue
    const fire = zonedTimeToUtc(y, mo, d, spec.hour, spec.minute, spec.tz)
    if (fire.getTime() <= now.getTime()) return fire
  }
  return null
}
