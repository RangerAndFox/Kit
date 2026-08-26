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
const ACTIONABLE_DAYS = 14

export function parsedReconciliationStatus(
  row: { check_in_date: string; parsed_entries: unknown; harvest_entry_ids: unknown },
  todayISO: string,
): 'skipped' | 'expired' | null {
  const cutoffDate = new Date(`${todayISO}T12:00:00Z`)
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - ACTIONABLE_DAYS)
  const cutoff = cutoffDate.toISOString().slice(0, 10)
  const entries = Array.isArray(row.parsed_entries) ? row.parsed_entries : []
  const hasPositiveHours = entries.some((entry: any) => Number(entry?.hours) > 0)
  const hasHarvestIds = Array.isArray(row.harvest_entry_ids) && row.harvest_entry_ids.length > 0
  if (!hasPositiveHours && !hasHarvestIds) return 'skipped'
  if (hasPositiveHours && row.check_in_date < cutoff) return 'expired'
  return null
}

/** Recent check-ins for the roll-up. Best-effort: throws are the caller's to swallow. */
export async function loadRecentCheckins(now: Date = new Date()): Promise<CheckinRow[]> {
  const since = studioDateMinusDays(LOOKBACK_DAYS, now)
  const { data, error } = await createAdminClient()
    .from('daily_hours_checkins')
    .select('check_in_date, status, reply_ts, harvest_entry_ids, parsed_entries, error_message, origin')
    .gte('check_in_date', since)
  if (error) throw new Error(`loadRecentCheckins: ${error.message}`)
  return (data as CheckinRow[]) || []
}

/**
 * Close parsed rows that can no longer be acted on safely. Zero-hour replies
 * are completed as skipped; positive-hour cards older than the confirmation
 * window become expired and require manual review instead of pretending to be
 * an actionable lost reply forever.
 */
export async function reconcileParsedCheckins(todayISO: string): Promise<{
  skippedZeroHour: number
  expired: number
}> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('daily_hours_checkins')
    .select('id, check_in_date, parsed_entries, harvest_entry_ids')
    .eq('status', 'parsed')
    .lte('check_in_date', todayISO)
  if (error) throw new Error(`reconcileParsedCheckins: ${error.message}`)

  let skippedZeroHour = 0
  let expired = 0
  for (const row of data || []) {
    const nextStatus = parsedReconciliationStatus(row, todayISO)
    if (!nextStatus) continue
    const { data: changed, error: updateError } = await sb
      .from('daily_hours_checkins')
      .update({
        status: nextStatus,
        error_message:
          nextStatus === 'skipped'
            ? 'Auto-closed: parsed reply contained no positive hours.'
            : `Auto-expired: confirmation window exceeded ${ACTIONABLE_DAYS} days; review manually.`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('status', 'parsed')
      .select('id')
    if (updateError) throw new Error(`reconcileParsedCheckins update: ${updateError.message}`)
    if (changed?.length) {
      if (nextStatus === 'skipped') skippedZeroHour++
      else expired++
    }
  }
  return { skippedZeroHour, expired }
}
