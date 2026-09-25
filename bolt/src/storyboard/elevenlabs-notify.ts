import crypto from 'node:crypto'
import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { upsertProjectLinks } from '../../../src/lib/project-control/sheets'
import { requestProjectControlSync } from '../../../src/lib/project-control/sync-request'
import { workbookConfigFromEnv } from '../../../src/lib/project-control/types'

const EVENT_TYPE = 'kit_elevenlabs_result'

function alreadyPosted(messages: any[], jobId: string): boolean {
  return messages.some((message) =>
    message?.metadata?.event_type === EVENT_TYPE &&
    message?.metadata?.event_payload?.job_id === jobId,
  )
}

export async function resolveElevenLabsDestination(client: App['client'], job: {
  slack_channel_id?: string; slack_thread_ts?: string; requested_by_slack_user_id?: string
}): Promise<string> {
  const stored = job.slack_channel_id?.trim()
  if (stored && /^[CDG][A-Z0-9]+$/.test(stored)) return stored
  // A thread belongs to its original conversation; never silently move it.
  if (job.slack_thread_ts) throw new Error('ElevenLabs thread has no valid conversation')
  const user = stored || job.requested_by_slack_user_id?.trim()
  if (!user || !/^[UW][A-Z0-9]+$/.test(user)) throw new Error('ElevenLabs notification destination missing or invalid')
  // Match resolveHoursReminderDm: a user ID is not a conversations.history channel.
  const opened = await client.conversations.open({ users: user })
  if (!opened.ok || !opened.channel?.id?.startsWith('D')) throw new Error('ElevenLabs requester DM unavailable')
  return opened.channel.id
}

async function findReceipt(client: App['client'], channel: string, thread: string | null, jobId: string): Promise<boolean> {
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const response = thread
      ? await client.conversations.replies({ channel, ts: thread, cursor, limit: 100, include_all_metadata: true } as any)
      : await client.conversations.history({ channel, cursor, limit: 100, include_all_metadata: true } as any)
    if (!response.ok) throw new Error('ElevenLabs notification history unavailable')
    if (alreadyPosted(response.messages || [], jobId)) return true
    cursor = response.response_metadata?.next_cursor
    if (!cursor && !response.has_more) return false
    if (!cursor) throw new Error('ElevenLabs notification history incomplete')
  }
  throw new Error('ElevenLabs notification history exceeds reconciliation window')
}

export async function reconcileElevenLabsDraftSlack(client: App['client']): Promise<{ scanned: number; notified: number }> {
  const sb = createAdminClient() as any
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data, error } = await sb.from('elevenlabs_studio_jobs').select('*')
    .in('status', ['complete', 'failed', 'retryable'])
    .is('slack_notified_at', null)
    .eq('slack_notification_disposition', 'pending')
    .or(`slack_notification_claim_token.is.null,slack_notification_claimed_at.lt.${cutoff}`)
    .order('updated_at', { ascending: true }).limit(20)
  if (error) throw new Error(`ElevenLabs Slack outbox read failed: ${error.message}`)
  let notified = 0
  const failures: string[] = []
  for (const job of data || []) {
    const token = crypto.randomUUID()
    let stage = 'claim'
    try {
      const { data: claimed, error: claimError } = await sb.from('elevenlabs_studio_jobs').update({
        slack_notification_claim_token: token,
        slack_notification_claimed_at: new Date().toISOString(),
      }).eq('id', job.id).is('slack_notified_at', null)
        .eq('slack_notification_disposition', 'pending')
        .or(`slack_notification_claim_token.is.null,slack_notification_claimed_at.lt.${cutoff}`)
        .select('id').maybeSingle()
      if (claimError) throw new Error(`ElevenLabs Slack claim failed: ${claimError.message}`)
      if (!claimed) continue
      stage = 'resolve_destination'
      const channel = await resolveElevenLabsDestination(client, job)
      stage = 'project_links'
      if (job.status === 'complete' && job.studio_url && job.kit_project_id) {
        const { data: project, error: projectError } = await sb.from('projects')
          .select('external_ids').eq('id', job.kit_project_id).maybeSingle()
        if (projectError) throw projectError
        const projectNumber = String(project?.external_ids?.project_number || '').trim()
        const config = workbookConfigFromEnv()
        if (config && projectNumber) {
          await upsertProjectLinks(config, projectNumber, { elevenlabsUrl: job.studio_url })
          await requestProjectControlSync(config, config.linksSheetId || config.sheetId)
        }
      }
      stage = 'reconcile_receipt'
      const posted = await findReceipt(client, channel, job.slack_thread_ts, job.id)
      // Persist the resolved destination and renew ownership immediately before
      // posting. A held job or a stale worker that lost its token cannot post.
      stage = 'renew_ownership'
      const { data: owned, error: ownershipError } = await sb.from('elevenlabs_studio_jobs').update({
        slack_channel_id: channel, slack_notification_claimed_at: new Date().toISOString(),
      }).eq('id', job.id).eq('slack_notification_claim_token', token)
        .eq('slack_notification_disposition', 'pending').is('slack_notified_at', null)
        .select('id').maybeSingle()
      if (ownershipError || !owned) throw new Error('ElevenLabs notification ownership lost')
      if (!posted) {
        stage = 'post_message'
        const success = job.status === 'complete' && job.studio_url
        const sent = await client.chat.postMessage({
          channel,
          ...(job.slack_thread_ts ? { thread_ts: job.slack_thread_ts } : {}),
          text: success
            ? `:white_check_mark: ElevenLabs Studio draft ready for *${job.project_name}*: ${job.studio_url}`
            : `:warning: ElevenLabs Studio needs attention for *${job.project_name}*: ${job.error || job.status}`,
          metadata: { event_type: EVENT_TYPE, event_payload: { job_id: job.id } },
          unfurl_links: false,
          unfurl_media: false,
        } as any)
        if (!sent.ok || !sent.ts) throw new Error('ElevenLabs notification was not acknowledged')
      }
      stage = 'persist_receipt'
      const { data: done, error: doneError } = await sb.from('elevenlabs_studio_jobs').update({
        slack_notified_at: new Date().toISOString(),
        slack_notification_claim_token: null,
        slack_notification_claimed_at: null,
      }).eq('id', job.id).eq('slack_notification_claim_token', token)
        .eq('slack_notification_disposition', 'pending').select('id').maybeSingle()
      if (doneError || !done) throw new Error('ElevenLabs notification acknowledgement not persisted')
      notified++
    } catch {
      const { error: releaseError } = await sb.from('elevenlabs_studio_jobs').update({
        slack_notification_claim_token: null,
        slack_notification_claimed_at: null,
      }).eq('id', job.id).eq('slack_notification_claim_token', token)
      // Continue through the batch, but do not report a successful cron while
      // any eligible job failed. Do not log raw provider messages or job URLs.
      failures.push(job.id)
      console.error('[ElevenLabs] notification failed', { jobId: job.id, stage, releaseFailed: Boolean(releaseError) })
    }
  }
  if (failures.length) throw new Error(`ElevenLabs notifications failed for ${failures.length} job(s); other jobs were processed`)
  return { scanned: (data || []).length, notified }
}
