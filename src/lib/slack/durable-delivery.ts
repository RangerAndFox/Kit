import { createHash, randomUUID } from 'node:crypto'
import { createAdminClient } from '../supabase/admin'
import { slackCall } from './transport'

interface Receipt { delivery_key: string; owner: string; channel_id: string; thread_ts: string | null; message_ts: string | null; created_at: string }
export interface DeliveryStore {
  claim(key: string, owner: string, channel: string, thread?: string): Promise<Receipt>
  acknowledge(key: string, ts: string): Promise<void>
  reject(key: string, owner: string): Promise<void>
}
function databaseStore(): DeliveryStore {
  // Additive migration, kept separate from generated schema until next refresh.
  const sb = createAdminClient() as unknown as { from(table: string): import('@supabase/supabase-js').SupabaseClient['from'] extends (...args: never[]) => infer R ? R : never }
  return {
    async claim(key, owner, channel, thread) {
      const { error } = await sb.from('delivery_notification_receipts').upsert({ delivery_key: key, owner, channel_id: channel, thread_ts: thread || null }, { onConflict: 'delivery_key', ignoreDuplicates: true })
      if (error) throw new Error('Slack delivery ledger claim failed')
      const result = await sb.from('delivery_notification_receipts').select('*').eq('delivery_key', key).single()
      if (result.error || !result.data) throw new Error('Slack delivery ledger unavailable')
      return result.data as Receipt
    },
    async acknowledge(key, ts) {
      const { data, error } = await sb.from('delivery_notification_receipts').update({ message_ts: ts, acknowledged_at: new Date().toISOString() })
        .eq('delivery_key', key).or(`message_ts.is.null,message_ts.eq.${ts}`).select('delivery_key')
      if (error || !data?.length) throw new Error('Slack delivery receipt could not be saved')
    },
    async reject(key, owner) {
      const { error } = await sb.from('delivery_notification_receipts').delete().eq('delivery_key', key).eq('owner', owner).is('message_ts', null)
      if (error) throw new Error('Slack rejection could not be recorded')
    },
  }
}

export async function assertNoStalledDeliveryReceipts(signal: AbortSignal): Promise<void> {
  const sb = createAdminClient() as unknown as import('@supabase/supabase-js').SupabaseClient
  const { data, error } = await sb.from('delivery_notification_receipts').select('delivery_key')
    .is('message_ts', null).lt('created_at', new Date(Date.now() - 5 * 60_000).toISOString()).limit(1).abortSignal(signal)
  if (error) throw new Error('Delivery acknowledgment state unavailable')
  if (data?.length) throw new Error('A delivery notification has an unconfirmed Slack outcome; review required before resending')
}

/** No repost on unknown outcomes, including a process crash before receipt save. */
export async function deliverSlackOnce(input: {
  key: string; channel: string; text: string; blocks?: unknown[]; threadTs?: string
}, dependencies: { store?: DeliveryStore; call?: typeof slackCall } = {}): Promise<string> {
  if (!input.channel) throw new Error('Slack destination is not configured')
  const store = dependencies.store || databaseStore()
  const call = dependencies.call || slackCall
  const owner = randomUUID()
  const key = createHash('sha256').update(JSON.stringify([input.key, input.channel, input.threadTs || null])).digest('hex')
  const receipt = await store.claim(key, owner, input.channel, input.threadTs)
  if (receipt.message_ts) return receipt.message_ts
  if (receipt.owner !== owner) {
    const identity = await call('auth.test', {})
    if (!identity.ok || !identity.user_id) throw new Error('Slack delivery outcome unconfirmed: bot identity unavailable')
    let cursor = ''
    for (let page = 0; page < 5; page++) {
      const result = await call(input.threadTs ? 'conversations.replies' : 'conversations.history', {
        channel: input.channel, include_all_metadata: true, limit: 100,
        ...(input.threadTs ? { ts: input.threadTs } : { oldest: String(Math.max(0, Date.parse(receipt.created_at) / 1000 - 60)) }),
        ...(cursor ? { cursor } : {}),
      })
      if (!result.ok) throw new Error('Slack delivery outcome unconfirmed: history unavailable')
      const found = result.messages?.find(m => m.user === identity.user_id && m.metadata?.event_type === 'kit_delivery_receipt' && m.metadata.event_payload?.delivery_key === key && m.ts)
      if (found?.ts) { await store.acknowledge(key, found.ts); return found.ts }
      cursor = result.response_metadata?.next_cursor || ''
      if (!cursor) break
    }
    // Absence does not prove an earlier in-flight request cannot still land.
    // Preserve the hold and fail visibly for review instead of duplicating it.
    throw new Error('Slack delivery outcome unconfirmed; retained for reconciliation, not reposted')
  }
  const result = await call('chat.postMessage', {
    channel: input.channel, text: input.text, mrkdwn: true, unfurl_links: false, unfurl_media: false,
    ...(input.blocks ? { blocks: input.blocks } : {}), ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    metadata: { event_type: 'kit_delivery_receipt', event_payload: { delivery_key: key } },
  })
  if (!result.ok) {
    await store.reject(key, owner) // Slack explicitly rejected; a corrected retry is safe.
    throw new Error(`Slack delivery rejected (${result.error || 'unknown'})`)
  }
  if (!result.ts) throw new Error('Slack accepted delivery without a receipt; retained for reconciliation')
  await store.acknowledge(key, result.ts)
  return result.ts
}
