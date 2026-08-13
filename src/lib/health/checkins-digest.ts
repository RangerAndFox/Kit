// @ts-nocheck
/**
 * Supabase I/O for the daily health digest: the recent daily_hours_checkins
 * rows the roll-up (`digest.ts`) counts.
 *
 * Read-only. The set is tiny (a handful of staff × ~30 days), so we pull the
 * rows and count in JS rather than push aggregate SQL through the client.
 *
 * "Today"/date-label come from the canonical studio-timezone helpers
 * (`src/lib/time/studio-date.ts`) — the SAME source the check-in write path
 * stamps check_in_date against — so the digest classifies today-vs-past the
 * way the rows were actually dated, not against a second hardcoded tz.
 */

import { createAdminClient } from '../supabase/admin'
import { studioDateMinusDays } from '../time/studio-date'
import type { CheckinRow } from './digest'

const LOOKBACK_DAYS = 30

/** Recent check-ins for the roll-up. Best-effort: throws are the caller's to swallow. */
export async function loadRecentCheckins(now: Date = new Date()): Promise<CheckinRow[]> {
  const since = studioDateMinusDays(LOOKBACK_DAYS, now)
  const { data, error } = await createAdminClient()
    .from('daily_hours_checkins')
    .select('check_in_date, status, reply_ts, harvest_entry_ids')
    .gte('check_in_date', since)
  if (error) throw new Error(`loadRecentCheckins: ${error.message}`)
  return (data as CheckinRow[]) || []
}
