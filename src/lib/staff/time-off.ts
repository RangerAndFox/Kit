/**
 * Per-person time off (PTO / sick / leave).
 *
 * Shared by both consumers of "is this person out?" — the daily hours check-in
 * send (skip the DM) and the missing-time monitor (don't count the days) — so
 * the rule lives here rather than being reimplemented per cron.
 *
 * Ranges are INCLUSIVE on both ends (see migration 063).
 */

import { createAdminClient } from '../supabase/admin'

/**
 * `staff_time_off` (migration 063) post-dates the generated Supabase types, so
 * the query goes through a structurally-typed view of the client rather than
 * the generated table union — the same approach `src/lib/pilots/store.ts` uses
 * for its own post-generation tables. Regenerating types will not break this.
 */
interface UntypedClient {
  from(table: string): any
}

function db(): UntypedClient {
  return createAdminClient() as unknown as UntypedClient
}

export interface TimeOffRange {
  start_date: string
  end_date: string
  kind?: string
  note?: string | null
}

/** Inclusive YYYY-MM-DD comparison. Dates are zero-padded, so string compare works. */
export function coversDate(range: TimeOffRange, ymd: string): boolean {
  return range.start_date <= ymd && ymd <= range.end_date
}

/**
 * Expand inclusive ranges into a set of YYYY-MM-DD, clipped to [from, to].
 * Pure — unit-tested. Clipping keeps a multi-month range from expanding into
 * thousands of entries when the caller only cares about a 3-week window.
 */
export function expandRanges(
  ranges: TimeOffRange[],
  from: string,
  to: string,
): Set<string> {
  const out = new Set<string>()
  if (from > to) return out
  for (const r of ranges || []) {
    if (!r?.start_date || !r?.end_date) continue
    // Skip ranges entirely outside the window.
    if (r.end_date < from || r.start_date > to) continue
    const start = r.start_date < from ? from : r.start_date
    const end = r.end_date > to ? to : r.end_date
    // Iterate at UTC noon so a DST boundary can never skip or repeat a day.
    for (
      let d = new Date(`${start}T12:00:00Z`);
      d.toISOString().slice(0, 10) <= end;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      out.add(d.toISOString().slice(0, 10))
    }
  }
  return out
}

/** Time-off ranges for one person overlapping [from, to]. */
export async function listTimeOffRanges(opts: {
  staffId: string
  from: string
  to: string
}): Promise<TimeOffRange[]> {
  const { data, error } = await db()
    .from('staff_time_off')
    .select('start_date, end_date, kind, note')
    .eq('staff_id', opts.staffId)
    .lte('start_date', opts.to)
    .gte('end_date', opts.from)
  if (error) {
    // Never silently treat a DB failure as "not on PTO": the caller decides,
    // and both callers prefer to keep their existing behavior over guessing.
    throw new Error(`load time off failed: ${error.message}`)
  }
  return (data as TimeOffRange[]) || []
}

/** Every day off for one person within [from, to], as YYYY-MM-DD. */
export async function listTimeOffDates(opts: {
  staffId: string
  from: string
  to: string
}): Promise<Set<string>> {
  const ranges = await listTimeOffRanges(opts)
  return expandRanges(ranges, opts.from, opts.to)
}

/**
 * True when this person is off on `date`. Returns false (not "unknown") only
 * when the lookup succeeded and found nothing — errors propagate to the caller.
 */
export async function isOnTimeOff(opts: {
  staffId: string
  date: string
}): Promise<boolean> {
  const ranges = await listTimeOffRanges({
    staffId: opts.staffId,
    from: opts.date,
    to: opts.date,
  })
  return ranges.some((r) => coversDate(r, opts.date))
}
