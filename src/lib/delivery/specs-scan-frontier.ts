// @ts-nocheck
/**
 * Persisted non-recursive traversal frontier for the specs-scan historical
 * backlog (table: delivery_specs_scan_frontier, migration 060).
 *
 * The frontier is the set of Dropbox folders still to visit. It is the durable
 * resume point for the breadth-first backlog traversal: a tick that dies mid-
 * visit leaves the folder in the frontier and re-visits it next tick. All
 * mutations are idempotent — enqueue is ON CONFLICT DO NOTHING (path is the
 * primary key), and deleting an already-deleted row is a no-op — so replay after
 * a partial visit or crash cannot duplicate or lose work.
 *
 * @ts-nocheck (matches the delivery subsystem) because the table postdates the
 * generated Supabase types. A test seam injects a fake client.
 */

import { createAdminClient } from '../supabase/admin'

const TABLE = 'delivery_specs_scan_frontier'

let clientFactory = createAdminClient

/** Test seam: swap the Supabase client factory for a fake. Pass null to restore. */
export function __setSpecsFrontierClientForTests(f) {
  clientFactory = f || createAdminClient
}

function db() {
  return clientFactory()
}

/** Enqueue folder paths to visit (idempotent — PK conflict is ignored). */
export async function enqueueFrontier(paths) {
  if (!paths || paths.length === 0) return
  const rows = paths.map((path) => ({ path }))
  const { error } = await db().from(TABLE).upsert(rows, { onConflict: 'path', ignoreDuplicates: true })
  if (error) throw new Error(`enqueueFrontier: ${error.message}`)
}

/**
 * Oldest-first batch of folders to visit (deterministic drain order). Throws on
 * a DB error so a failed read never masquerades as a drained frontier (which
 * would wrongly mark the backlog complete).
 */
export async function loadFrontierBatch(limit) {
  const { data, error } = await db()
    .from(TABLE)
    .select('path')
    .order('created_at', { ascending: true })
    .order('path', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`loadFrontierBatch: ${error.message}`)
  return (data || []).map((r) => r.path)
}

/** Remove a visited folder from the frontier. */
export async function deleteFrontierPath(path) {
  const { error } = await db().from(TABLE).delete().eq('path', path)
  if (error) throw new Error(`deleteFrontierPath(${path}): ${error.message}`)
}
