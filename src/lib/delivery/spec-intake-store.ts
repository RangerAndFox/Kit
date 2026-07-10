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
  output_dir?: string | null
}

/** Record a posted delivery prompt so a later thread reply can be tied back. */
export async function recordSpecIntake(opts: {
  channelId: string
  threadTs: string
  sources: SourceFile[]
  outputDir?: string   // deliver here instead of <sourceDir>/delivery (AE renders)
}): Promise<void> {
  const sb = createAdminClient()
  await sb.from('delivery_spec_intake').upsert(
    {
      channel_id: opts.channelId,
      thread_ts: opts.threadTs,
      sources: opts.sources,
      status: 'open',
      output_dir: opts.outputDir ?? null,
    },
    { onConflict: 'channel_id,thread_ts' },
  )
  invalidateSpecIntakeChannelCache()
}

/** Look up an OPEN intake for a thread (the prompt the operator is replying to). */
export async function getOpenSpecIntake(
  channelId: string,
  threadTs: string,
): Promise<SpecIntakeRow | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('delivery_spec_intake')
    .select('id, channel_id, thread_ts, sources, status, output_dir')
    .eq('channel_id', channelId)
    .eq('thread_ts', threadTs)
    .eq('status', 'open')
    .maybeSingle()
  return (data as SpecIntakeRow) || null
}

// ── Cheap pre-filter for the Bolt hot path ──────────────────
// Every threaded message in every channel used to fire a Supabase query just
// to check "is this an open spec-intake thread?". Cache the SET of channels
// with any open intake (refreshed every 60s, invalidated on record/consume)
// so the per-message check is an in-memory Set lookup; the precise per-thread
// query only runs for channels that actually have an open prompt.
const CHANNEL_CACHE_TTL_MS = 60 * 1000
let _openChannels: { set: Set<string>; at: number } | null = null

export async function channelHasOpenSpecIntake(channelId: string): Promise<boolean> {
  if (!_openChannels || Date.now() - _openChannels.at > CHANNEL_CACHE_TTL_MS) {
    const sb = createAdminClient()
    const { data } = await sb
      .from('delivery_spec_intake')
      .select('channel_id')
      .eq('status', 'open')
    _openChannels = {
      set: new Set((data || []).map((r: any) => r.channel_id)),
      at: Date.now(),
    }
  }
  return _openChannels.set.has(channelId)
}

/** Drop the cache (a prompt was just posted or consumed). */
export function invalidateSpecIntakeChannelCache(): void {
  _openChannels = null
}

export async function consumeSpecIntake(id: string): Promise<void> {
  const sb = createAdminClient()
  await sb
    .from('delivery_spec_intake')
    .update({ status: 'consumed', consumed_at: new Date().toISOString() })
    .eq('id', id)
  invalidateSpecIntakeChannelCache()
}
