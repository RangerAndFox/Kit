// @ts-nocheck
/**
 * Supabase I/O for the daily health digest: the recent daily_hours_checkins
 * rows the roll-up (`digest.ts`) counts, plus the studio-local "today".
 *
 * Read-only. The set is tiny (a handful of staff × ~30 days), so we pull the
 * rows and count in JS rather than push aggregate SQL through the client.
 */

import { createAdminClient } from '../supabase/admin'
import type { CheckinRow } from './digest'

const LOOKBACK_DAYS = 30
const STUDIO_TZ = 'America/New_York'

/** Today's date ('YYYY-MM-DD') in the studio timezone. */
export function studioToday(now: Date = new Date(), tz: string = STUDIO_TZ): string {
  // en-CA renders as YYYY-MM-DD; formatting in `tz` gives the local calendar day.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** A short, human date label for the digest header, e.g. "Tue Aug 12". */
export function studioDateLabel(now: Date = new Date(), tz: string = STUDIO_TZ): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(now)
}

/** Recent check-ins for the roll-up. Best-effort: throws are the caller's to swallow. */
export async function loadRecentCheckins(now: Date = new Date()): Promise<CheckinRow[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10)
  const { data, error } = await createAdminClient()
    .from('daily_hours_checkins')
    .select('check_in_date, status, reply_ts, harvest_entry_ids')
    .gte('check_in_date', since)
  if (error) throw new Error(`loadRecentCheckins: ${error.message}`)
  return (data as CheckinRow[]) || []
}
