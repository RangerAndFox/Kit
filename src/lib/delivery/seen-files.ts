// @ts-nocheck
/**
 * Shared helpers for the seen_dropbox_files stability ledger used by both
 * Dropbox pollers (delivery queue + specs folders).
 *
 * The pollers used to `select('*')` the whole table every minute — a table
 * that only ever grows — and insert first-sightings one row at a time.
 * These helpers scope reads to the ids in the current scan and batch writes.
 */

import { createAdminClient } from '../supabase/admin'

const CHUNK = 200

/**
 * Fetch seen rows for exactly these dropbox ids (chunked .in() queries).
 * THROWS on a DB error — a failed read must never masquerade as "no rows seen",
 * which would let a scan re-process or mis-gate files (invariant 15's spirit).
 */
export async function getSeenRowsByIds(ids: string[]): Promise<Record<string, any>> {
  const sb = createAdminClient()
  const byId: Record<string, any> = {}
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const { data, error } = await sb.from('seen_dropbox_files').select('*').in('dropbox_id', chunk)
    if (error) throw new Error(`getSeenRowsByIds: ${error.message}`)
    for (const row of data || []) byId[row.dropbox_id] = row
  }
  return byId
}

/**
 * Insert first-sighting rows in one batch instead of one insert per file.
 * THROWS on a DB error: callers checkpoint a cursor past the recorded page, so a
 * silently-failed write would strand those files (in delta mode they never
 * reappear) and no delivery prompt would ever fire. Surfacing it aborts the tick
 * BEFORE the cursor advances, so the page replays safely next tick.
 */
export async function insertFirstSightings(
  rows: { dropbox_id: string; path: string; size_bytes: number }[],
): Promise<void> {
  if (rows.length === 0) return
  const sb = createAdminClient()
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await sb.from('seen_dropbox_files').upsert(
      rows.slice(i, i + CHUNK).map((r) => ({ ...r, stable_check_count: 1 })),
      { onConflict: 'dropbox_id', ignoreDuplicates: true },
    )
    if (error) throw new Error(`insertFirstSightings: ${error.message}`)
  }
}
