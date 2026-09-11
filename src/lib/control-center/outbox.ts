import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '../supabase/admin'

export const outboxDb = (): SupabaseClient => createAdminClient() as SupabaseClient

export interface OutboxRow {
  id: string
  project_id: string
  kind: 'sync_alert' | 'control_action'
  payload: Record<string, string>
  attempts: number
  send_started: boolean
  created_at: string
}

export interface OutboxPorts {
  markStarted(started: boolean): Promise<void>
  reconcile(): Promise<{ state: 'found'; ts: string } | { state: 'absent' | 'unknown' }>
  post(): Promise<{ ok: boolean; ts?: string }>
  action(): Promise<void>
  finish(status: 'sent' | 'retry' | 'review', error?: string, ts?: string): Promise<void>
}

/** After an ambiguous send (including a crash), reconcile before any repost. */
export async function deliverOutbox(row: OutboxRow, ports: OutboxPorts): Promise<void> {
  try {
    if (row.kind === 'control_action') {
      await ports.action()
      await ports.finish('sent')
      return
    }
    if (row.send_started) {
      const result = await ports.reconcile()
      if (result.state === 'found') {
        await ports.finish('sent', undefined, result.ts)
        return
      }
      if (result.state === 'unknown') {
        await ports.finish(row.attempts >= 12 ? 'review' : 'retry', 'Slack delivery unconfirmed; reconciliation unavailable')
        return
      }
    }
    await ports.markStarted(true)
    const result = await ports.post()
    if (!result.ok) {
      // Explicit ok:false is proof Slack did not post. No history read needed on retry.
      await ports.markStarted(false)
      throw new Error('Slack rejected delivery')
    }
    if (!result.ts) throw new Error('Slack did not acknowledge delivery')
    await ports.finish('sent', undefined, result.ts)
  } catch {
    // Deliberately avoid persisting raw provider responses or secrets.
    await ports.finish(row.attempts >= 12 ? 'review' : 'retry', 'Operation not confirmed; retry/reconciliation required')
  }
}

export async function enqueueSyncAlert(projectId: string, key: string, text: string): Promise<void> {
  const channel = process.env.KIT_PROJECT_CONTROL_ALERT_CHANNEL_ID || process.env.KIT_HEALTH_CHANNEL_ID
  const { error } = await outboxDb().rpc('enqueue_project_sync_alert', {
    p_project_id: projectId, p_key: key, p_channel: channel || '', p_text: text,
  })
  if (error) throw new Error('Could not persist sync alert')
}
