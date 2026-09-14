import { z } from 'zod'

/** PostgREST table-valued RPCs use row arrays unless a singular representation is requested. */
export function cultureRpcRow(value: unknown): (Record<string, unknown> & { id: string }) | null {
  if (Array.isArray(value)) {
    if (value.length > 1) throw new Error('Culture RPC returned more than one row.')
    value = value[0] ?? null
  }
  if (value === null) return null
  if (typeof value !== 'object') throw new Error('Culture RPC returned an invalid row.')
  const row = value as Record<string, unknown>
  // A SQL NULL composite can be represented as an object with all-null fields.
  if (row.id === null && Object.values(row).every(field => field === null)) return null
  const id = z.string().uuid().parse(row.id)
  return { ...row, id }
}
