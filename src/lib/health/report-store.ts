import { createAdminClient } from '../supabase/admin'
import { loadHealthRows } from './state'
import { deliverSlackOnce } from '../slack/durable-delivery'
import { slackCall } from '../slack/transport'
import { publishHealthReport, type HealthReport, type HealthReportStore, type PendingReport, type ReportPlan } from './reporting'

// Both reporters use the existing private health destination, never a public
// channel. This also makes a digest incident and its recovery reach one person.
export function healthRecipient(): string {
  return process.env.KIT_HEALTH_CHANNEL_ID || process.env.KIT_HEALTH_DIGEST_USER_ID || 'U4CA7HXT9'
}

export async function resolveHealthDm(recipient: string, call = slackCall): Promise<string> {
  if (/^D[A-Z0-9]+$/.test(recipient)) return recipient
  if (!/^U[A-Z0-9]+$/.test(recipient)) throw new Error('Health reports require a private Kit DM')
  const result = await call('conversations.open', { users: recipient })
  if (!result.ok || !result.channel?.id?.startsWith('D')) throw new Error('Health DM could not be opened')
  return result.channel.id
}

function databaseStore(): HealthReportStore {
  const db = createAdminClient() as unknown as import('@supabase/supabase-js').SupabaseClient
  const deadline = () => AbortSignal.timeout(5000)
  return {
    async enqueue(report) {
      const { error } = await db.from('health_reports').upsert({ id: report.id, observed_at: report.observed_at, payload: report },
        { onConflict: 'id', ignoreDuplicates: true }).abortSignal(deadline())
      if (error) throw new Error('Health report enqueue unavailable')
    },
    async pending() {
      const { data, error } = await db.from('health_reports').select('payload, plan').is('completed_at', null)
        .order('created_at').order('id').limit(20).abortSignal(deadline())
      if (error) throw new Error('Health reporting queue unavailable')
      return (data ?? []).map(row => ({ ...row.payload, plan: row.plan })) as PendingReport[]
    },
    state: loadHealthRows,
    async plan(id, plan) {
      const { error } = await db.from('health_reports').update({ plan }).eq('id', id).is('plan', null).abortSignal(deadline())
      if (error) throw new Error('Health report plan unavailable')
      const result = await db.from('health_reports').select('plan').eq('id', id).abortSignal(deadline()).single()
      if (result.error || !result.data?.plan) throw new Error('Health report plan could not be read')
      return result.data.plan as ReportPlan
    },
    async complete(id) {
      const { error } = await db.rpc('complete_health_report', { p_id: id }).abortSignal(deadline())
      if (error) throw new Error('Health incident state could not be committed')
    },
  }
}

export async function reportHealth(report: HealthReport): Promise<void> {
  if (!process.env.SLACK_BOT_TOKEN) throw new Error('Health reporting Slack token is not configured')
  await publishHealthReport(report, { store: databaseStore(), resolveDm: resolveHealthDm, send: deliverSlackOnce })
}
