import { createAdminClient } from '../../../src/lib/supabase/admin'
import type { KitCommandName } from './command-catalog'
import type { SupabaseClient } from '@supabase/supabase-js'

export type CommandRecord = {
  id: string
  request_key: string
  workspace_id: string
  team_id: string
  user_id: string
  source_channel: string
  dm_channel: string
  thread_ts?: string | null
  command: KitCommandName
  args: string
  status: 'pending' | 'running' | 'complete' | 'cancelled' | 'review'
  expires_at: string
}
type CommandDatabase = { public: { Tables: { kit_command_requests: { Row: CommandRecord; Insert: Partial<CommandRecord>; Update: Partial<CommandRecord> & { updated_at?: string }; Relationships: [] } }; Views: Record<string, never>; Functions: Record<string, never> } }
const table = () => (createAdminClient() as unknown as SupabaseClient<CommandDatabase>).from('kit_command_requests')
function checked(error: unknown): void { if (error) throw new Error('Command checkpoint unavailable') }

export async function saveCommandRequest(record: Omit<CommandRecord, 'id' | 'status' | 'expires_at'>): Promise<CommandRecord | null> {
  const { data, error } = await table().upsert(record, { onConflict: 'request_key', ignoreDuplicates: true }).select('*').maybeSingle()
  checked(error)
  return data
}

export async function readCommandRequest(id: string, actor: string, team: string, dm: string): Promise<CommandRecord | null> {
  const { data, error } = await table().select('*').eq('id', id).eq('user_id', actor).eq('team_id', team).eq('dm_channel', dm).maybeSingle()
  checked(error)
  return data
}

/** Atomic compare-and-set. No lease/reclaim: an uncertain write must not replay. */
export async function claimCommandRequest(record: CommandRecord, cancel = false): Promise<boolean> {
  const { data, error } = await table().update({ status: cancel ? 'cancelled' : 'running', ...(cancel ? { args: '' } : {}), updated_at: new Date().toISOString() })
    .eq('id', record.id).eq('user_id', record.user_id).eq('team_id', record.team_id).eq('dm_channel', record.dm_channel)
    .eq('status', 'pending').gt('expires_at', new Date().toISOString()).select('id').maybeSingle()
  checked(error)
  return !!data
}

export async function finishCommandRequest(id: string, status: 'complete' | 'review'): Promise<void> {
  const { data, error } = await table().update({ status, args: '', updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'running').select('id').maybeSingle()
  checked(error)
  if (!data) throw new Error('Command receipt could not be recorded')
}
