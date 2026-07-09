// @ts-nocheck
/**
 * Backfill: log confirmed-but-unlogged daily check-ins to Harvest.
 *
 * The confirm button/typed-yes was broken for a stretch, so a backlog of
 * status='parsed' check-ins never reached Harvest. This sweeps them:
 *   - only rows where EVERY entry matched a Harvest project (an unmatched
 *     "internal" line means we can't log it — left for the person to fix)
 *   - deduped across rows by (staff, date, project, hours) so a double
 *     submission (e.g. two identical "8h Meera" rows) logs once
 *   - idempotent: only touches status='parsed', writes harvest_entry_ids
 *     and flips to 'logged', so a second run is a no-op
 *
 * `dryRun` reports exactly what WOULD be written without calling Harvest.
 * Admin-triggered via `/kit backfill-time [preview]`.
 */

import { createAdminClient } from '../../../src/lib/supabase/admin'
import { createTimeEntry, getDefaultTask } from '../../../src/lib/harvest/client'

export interface BackfillEntryPlan {
  staffName: string
  harvestUserId: number
  date: string
  projectId: number
  projectName: string
  hours: number
  notes?: string
  checkinId: string
}

export interface BackfillResult {
  dryRun: boolean
  planned: BackfillEntryPlan[]
  logged: { plan: BackfillEntryPlan; entryId: number }[]
  duplicatesCollapsed: number
  skippedRows: { staffName: string; date: string; reason: string }[]
  failures: { plan: BackfillEntryPlan; error: string }[]
}

interface Row {
  id: string
  staff_id: string
  check_in_date: string
  parsed_entries: any[]
  staff: { full_name: string | null; harvest_user_id: number | null }
}

export async function backfillCheckins(opts: { dryRun: boolean }): Promise<BackfillResult> {
  const sb = createAdminClient()
  const { data: rows, error } = await sb
    .from('daily_hours_checkins')
    .select('id, staff_id, check_in_date, parsed_entries, staff:staff_id(full_name, harvest_user_id)')
    .eq('status', 'parsed')
    .order('check_in_date', { ascending: true })
  if (error) throw new Error(`backfill load failed: ${error.message}`)

  const result: BackfillResult = {
    dryRun: opts.dryRun,
    planned: [],
    logged: [],
    duplicatesCollapsed: 0,
    skippedRows: [],
    failures: [],
  }

  const seen = new Set<string>()
  // Map each planned entry back to the rows it satisfies, so we can flip
  // every collapsed duplicate row to 'logged' pointing at the same entry.
  const rowsForKey = new Map<string, string[]>()

  for (const r of (rows as Row[]) || []) {
    const staffName = r.staff?.full_name || '(unknown)'
    const harvestUserId = r.staff?.harvest_user_id
    const entries = Array.isArray(r.parsed_entries) ? r.parsed_entries : []

    if (!harvestUserId) {
      result.skippedRows.push({ staffName, date: r.check_in_date, reason: 'no harvest_user_id' })
      continue
    }
    if (entries.length === 0) {
      result.skippedRows.push({ staffName, date: r.check_in_date, reason: 'no entries' })
      continue
    }
    const allMatched = entries.every((e: any) => e.resolution === 'matched' && e.harvest_project_id)
    if (!allMatched) {
      const bad = entries.find((e: any) => e.resolution !== 'matched')
      result.skippedRows.push({
        staffName,
        date: r.check_in_date,
        reason: `unmatched project "${bad?.projectQuery ?? '?'}"`,
      })
      continue
    }

    for (const e of entries) {
      const date = e.spentDate || r.check_in_date
      const key = `${harvestUserId}|${date}|${e.harvest_project_id}|${e.hours}`
      if (seen.has(key)) {
        result.duplicatesCollapsed++
        rowsForKey.get(key)?.push(r.id)
        continue
      }
      seen.add(key)
      rowsForKey.set(key, [r.id])
      result.planned.push({
        staffName,
        harvestUserId,
        date,
        projectId: e.harvest_project_id,
        projectName: e.harvest_project_name || String(e.harvest_project_id),
        hours: e.hours,
        notes: e.notes || undefined,
        checkinId: r.id,
      })
    }
  }

  if (opts.dryRun) return result

  // Group planned entries by their originating row so we can stamp the row
  // 'logged' with the entry ids once all its entries are written.
  const entryIdsByRow = new Map<string, number[]>()

  for (const plan of result.planned) {
    try {
      const task = await getDefaultTask(plan.projectId)
      if (!task) {
        result.failures.push({ plan, error: 'no default task on project' })
        continue
      }
      const te = await createTimeEntry({
        projectId: plan.projectId,
        taskId: task.id,
        hours: plan.hours,
        spentDate: plan.date,
        notes: plan.notes,
        userId: plan.harvestUserId,
      })
      result.logged.push({ plan, entryId: te.id })
      const key = `${plan.harvestUserId}|${plan.date}|${plan.projectId}|${plan.hours}`
      for (const rowId of rowsForKey.get(key) || [plan.checkinId]) {
        const arr = entryIdsByRow.get(rowId) || []
        arr.push(te.id)
        entryIdsByRow.set(rowId, arr)
      }
    } catch (err: any) {
      result.failures.push({ plan, error: err.message })
    }
  }

  // Flip every fully-logged row (and its collapsed duplicates) to 'logged'.
  for (const [rowId, ids] of entryIdsByRow) {
    await sb
      .from('daily_hours_checkins')
      .update({
        status: 'logged',
        logged_at: new Date().toISOString(),
        harvest_entry_ids: ids,
        updated_at: new Date().toISOString(),
      })
      .eq('id', rowId)
      .eq('status', 'parsed')
  }

  return result
}
