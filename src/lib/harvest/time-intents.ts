import { randomUUID } from 'node:crypto'
import { createAdminClient } from '../supabase/admin'

export interface TimeIntentStore {
  claim(): Promise<boolean>
  commit(id: number): Promise<void>
  reconcile(id: number): Promise<void>
  reject(): Promise<void>
}

export function timeIntentStore(account: string, key: string): TimeIntentStore {
  const owner = randomUUID()
  const db = createAdminClient() as unknown as { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }
  const record = async (action: string, entryId?: number) => {
    const { data, error } = await db.rpc('record_harvest_time_intent', { p_account: account, p_key: key, p_owner: owner, p_action: action, p_entry_id: entryId ?? null })
    if (error) throw new Error('Time-entry safety ledger is unavailable; no additional write is permitted')
    return data === true
  }
  return {
    claim: () => record('claim'),
    commit: async id => { await record('commit', id) },
    reconcile: async id => { await record('reconcile', id) },
    reject: async () => { await record('reject') },
  }
}

/** Shared claim, not a process mutex. Never re-post an ambiguous earlier write. */
export async function guardedTimeWrite<T extends { id: number }>(io: {
  store: TimeIntentStore
  lookup: (attempts: number) => Promise<T | null>
  post: () => Promise<T>
  definitelyRejected: (error: unknown) => boolean
}): Promise<T & { reused?: boolean }> {
  const found = await io.lookup(1) // A failed preflight read must fail closed.
  if (found) {
    await io.store.reconcile(found.id)
    return { ...found, reused: true }
  }
  if (!await io.store.claim()) {
    const prior = await io.lookup(3)
    if (prior) {
      await io.store.reconcile(prior.id)
      return { ...prior, reused: true }
    }
    throw new Error('Matching hours are processing or have an unconfirmed Harvest outcome. Nothing was sent again; an admin must reconcile if this persists.')
  }
  try {
    const entry = await io.post()
    await io.store.commit(entry.id)
    return entry
  } catch (error) {
    // A successful provider write followed by a lost reply/DB failure is not
    // permission to POST again. Keep the durable hold when lookup is unknown.
    const prior = await io.lookup(3).catch(() => null)
    if (prior) {
      await io.store.reconcile(prior.id)
      return { ...prior, reused: true }
    }
    if (io.definitelyRejected(error)) await io.store.reject()
    throw error
  }
}
