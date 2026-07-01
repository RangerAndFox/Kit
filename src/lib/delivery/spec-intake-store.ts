// @ts-nocheck
/**
 * Storage for delivery spec-intake rows (delivery_spec_intake, migration 034).
 *
 * Kept in its own @ts-nocheck module because the generated supabase types
 * aren't regenerated here — same pattern as the other recently-added tables
 * (hours_missing_alerts, daily_hours_checkins) accessed from @ts-nocheck files.
 */

import { createAdminClient } from '../supabase/admin'
import type { SourceFile } from './types'

export interface SpecIntakeRow {
  id: string
  channel_id: string
  thread_ts: string
  sources: SourceFile[]
  status: string
}

/** Record a posted delivery prompt so a later thread reply can be tied back. */
export async function recordSpecIntake(opts: {
  channelId: string
  threadTs: string
  sources: SourceFile[]
}): Promise<void> {
  const sb = createAdminClient()
  await sb.from('delivery_spec_intake').upsert(
    {
      channel_id: opts.channelId,
      thread_ts: opts.threadTs,
      sources: opts.sources,
      status: 'open',
    },
    { onConflict: 'channel_id,thread_ts' },
  )
}

/** Look up an OPEN intake for a thread (the prompt the operator is replying to). */
export async function getOpenSpecIntake(
  channelId: string,
  threadTs: string,
): Promise<SpecIntakeRow | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('delivery_spec_intake')
    .select('id, channel_id, thread_ts, sources, status')
    .eq('channel_id', channelId)
    .eq('thread_ts', threadTs)
    .eq('status', 'open')
    .maybeSingle()
  return (data as SpecIntakeRow) || null
}

export async function consumeSpecIntake(id: string): Promise<void> {
  const sb = createAdminClient()
  await sb
    .from('delivery_spec_intake')
    .update({ status: 'consumed', consumed_at: new Date().toISOString() })
    .eq('id', id)
}
