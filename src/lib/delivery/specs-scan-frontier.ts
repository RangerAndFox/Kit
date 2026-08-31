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
 * A test seam injects a compatible client.
 */

import { createAdminClient } from '../supabase/admin'

const TABLE = 'delivery_specs_scan_frontier'

type SpecsFrontierClient = ReturnType<typeof createAdminClient>
type SpecsFrontierClientFactory = () => SpecsFrontierClient

let clientFactory: SpecsFrontierClientFactory = createAdminClient

/** Test seam: swap the Supabase client factory for a fake. Pass null to restore. */
export function __setSpecsFrontierClientForTests(f: (() => unknown) | null) {
  clientFactory = f ? f as SpecsFrontierClientFactory : createAdminClient
}

function db() {
  return clientFactory()
}

/** Enqueue folder paths to visit (idempotent — PK conflict is ignored). */
export async function enqueueFrontier(paths: string[]): Promise<void> {
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
export async function loadFrontierBatch(limit: number): Promise<string[]> {
  const { data, error } = await db()
    .from(TABLE)
    .select('path')
    .order('created_at', { ascending: true })
    .order('path', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`loadFrontierBatch: ${error.message}`)
  return (data || []).map((r) => r.path)
}

/**
 * Atomically complete one backlog folder visit under holder+fence ownership
 * (migration 061 `specs_backlog_commit_folder`): enqueue children (idempotent)
 * + delete the parent in ONE transaction, or mutate nothing if the lease is
 * stale. Returns true iff it committed; false means the lease was lost and the
 * caller must stop (the parent stays for the real owner to re-visit).
 */
export async function commitBacklogFolder(
  holder: string,
  fence: number,
  parent: string,
  children: string[],
): Promise<boolean> {
  const { data, error } = await db().rpc('specs_backlog_commit_folder', {
    p_holder: holder,
    p_fence: fence,
    p_parent: parent,
    p_children: children || [],
  })
  if (error) throw new Error(`commitBacklogFolder(${parent}): ${error.message}`)
  return !!data
}

/**
 * Atomically mark the backlog complete ONLY when the caller owns the lease AND
 * the frontier is empty, both checked in the same transaction (migration 061
 * `specs_backlog_mark_complete_if_empty`). Returns true iff it was set — never
 * completes while any frontier row remains, and a stale caller changes nothing.
 */
export async function markBacklogCompleteIfEmpty(holder: string, fence: number): Promise<boolean> {
  const { data, error } = await db().rpc('specs_backlog_mark_complete_if_empty', {
    p_holder: holder,
    p_fence: fence,
  })
  if (error) throw new Error(`markBacklogCompleteIfEmpty: ${error.message}`)
  return !!data
}
