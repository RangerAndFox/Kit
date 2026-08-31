import crypto from 'node:crypto'
import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'

const EVENT_TYPE = 'kit_elevenlabs_result'

function alreadyPosted(messages: any[], jobId: string): boolean {
  return messages.some((message) =>
    message?.metadata?.event_type === EVENT_TYPE &&
    message?.metadata?.event_payload?.job_id === jobId,
  )
}

export async function reconcileElevenLabsDraftSlack(client: App['client']): Promise<{ scanned: number; notified: number }> {
  const sb = createAdminClient() as any
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data, error } = await sb.from('elevenlabs_studio_jobs').select('*')
    .in('status', ['complete', 'failed', 'retryable'])
    .is('slack_notified_at', null)
    .or(`slack_notification_claim_token.is.null,slack_notification_claimed_at.lt.${cutoff}`)
    .order('updated_at', { ascending: true }).limit(20)
  if (error) throw new Error(`ElevenLabs Slack outbox read failed: ${error.message}`)
  let notified = 0
  for (const job of data || []) {
    const token = crypto.randomUUID()
    const { data: claimed, error: claimError } = await sb.from('elevenlabs_studio_jobs').update({
      slack_notification_claim_token: token,
      slack_notification_claimed_at: new Date().toISOString(),
    }).eq('id', job.id).is('slack_notified_at', null)
      .or(`slack_notification_claim_token.is.null,slack_notification_claimed_at.lt.${cutoff}`)
      .select('id').maybeSingle()
    if (claimError) throw new Error(`ElevenLabs Slack claim failed: ${claimError.message}`)
    if (!claimed) continue
    const channel = job.slack_channel_id || job.requested_by_slack_user_id
    if (!channel) {
      await sb.from('elevenlabs_studio_jobs').update({
        slack_notification_claim_token: null,
        slack_notification_claimed_at: null,
      }).eq('id', job.id).eq('slack_notification_claim_token', token)
      console.error(`[ElevenLabs] job ${job.id} has no Slack notification destination`)
      continue
    }
    try {
      const messages: any = job.slack_thread_ts
        ? await client.conversations.replies({
          channel,
          ts: job.slack_thread_ts,
          limit: 100,
          include_all_metadata: true,
        } as any)
        : await client.conversations.history({ channel, limit: 100, include_all_metadata: true } as any)
      if (!alreadyPosted(messages.messages || [], job.id)) {
        const success = job.status === 'complete' && job.studio_url
        await client.chat.postMessage({
          channel,
          ...(job.slack_thread_ts ? { thread_ts: job.slack_thread_ts } : {}),
          text: success
            ? `:white_check_mark: ElevenLabs Studio draft ready for *${job.project_name}*: ${job.studio_url}`
            : `:warning: ElevenLabs Studio needs attention for *${job.project_name}*: ${job.error || job.status}`,
          metadata: { event_type: EVENT_TYPE, event_payload: { job_id: job.id } },
          unfurl_links: false,
        } as any)
      }
      const { error: doneError } = await sb.from('elevenlabs_studio_jobs').update({
        slack_notified_at: new Date().toISOString(),
        slack_notification_claim_token: null,
        slack_notification_claimed_at: null,
      }).eq('id', job.id).eq('slack_notification_claim_token', token)
      if (doneError) throw doneError
      notified++
    } catch (notifyError) {
      await sb.from('elevenlabs_studio_jobs').update({
        slack_notification_claim_token: null,
        slack_notification_claimed_at: null,
      }).eq('id', job.id).eq('slack_notification_claim_token', token)
      throw notifyError
    }
  }
  return { scanned: (data || []).length, notified }
}
