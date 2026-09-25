/**
 * Delivery pipeline cron jobs.
 *
 *   deliveryDropboxScan   — every minute, polls /Delivery-Queue/ for new files,
 *                           posts a Slack notification with a "Pick Profile"
 *                           prompt for each newly-stable file.
 *
 *   deliveryJobNotifier   — every minute, finds render_jobs that transitioned to
 *                           complete/failed since the last poll and posts a
 *                           Slack notification (or edits the prior one).
 *
 *   deliveryStaleSweep    — every 60s, resets jobs whose worker has gone stale.
 *
 * All three skip silently when their dependencies aren't met (no Dropbox token,
 * no Slack token, etc.).
 */

import { inngest } from './client'
import { createAdminClient } from '../supabase/admin'
import { scanDeliveryQueue, markFileNotified, resolveDeliveryChannel } from '../delivery/dropbox-watcher'
import { isSrtFile } from '../delivery/subtitle-convert'
import { processSrtFile } from '../delivery/subtitle-watcher'
import { runSpecsScanTick } from '../delivery/specs-watcher'
import { progressBar } from '../delivery/progress-bar'
import { resetStaleJobs } from '../delivery/storage'
import { deliverSlackOnce } from '../slack/durable-delivery'
import { slackCall } from '../slack/transport'
import { recordCronAttempt, recordCronSuccess } from '../health/state'

const DEFAULT_NOTIFY_CHANNEL = process.env.DELIVERY_NOTIFY_CHANNEL_ID || ''

async function slackPost(channel: string, text: string, blocks?: unknown[], threadTs?: string, key?: string): Promise<string> {
  if (!key) throw new Error('Delivery notifications require a durable key')
  return deliverSlackOnce({ key, channel, text, blocks, threadTs })
}

/** Post first, then mark. A failed Slack request must leave the Dropbox file
 * eligible for the next scan instead of silently losing its delivery prompt. */
export async function completeDeliveryFileNotification(opts: {
  dropboxId: string
  post: () => Promise<string | null>
  mark: (dropboxId: string) => Promise<void>
}): Promise<boolean> {
  const ts = await opts.post()
  if (!ts) return false
  await opts.mark(opts.dropboxId)
  return true
}

async function slackUpdate(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<boolean> {
  const result = await slackCall('chat.update', { channel, ts, text, mrkdwn: true, ...(blocks ? { blocks } : {}) })
  if (!result.ok) throw new Error(`Slack update rejected (${result.error || 'unknown'})`)
  return true
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ─── Dropbox poller ────────────────────────────────────────

export const deliveryDropboxScan = inngest.createFunction(
  {
    id: 'delivery-dropbox-scan',
    name: 'Delivery — Dropbox /Delivery-Queue/ scan',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '*/1 * * * *' }], // every minute (Inngest min granularity)
  },
  async ({ step, logger }) => {
    await step.run('heartbeat', async () => {
      try { await recordCronAttempt('delivery-dropbox-scan') } catch {}
      return true
    })
    if (!process.env.DROPBOX_ACCESS_TOKEN && !process.env.DROPBOX_REFRESH_TOKEN) {
      return { skipped: 'no_dropbox_token' }
    }

    const newFiles = await step.run('scan', () => scanDeliveryQueue())

    let notified = 0
    let converted = 0
    for (const f of newFiles) {
      const name = f.path.split(/[\\/]/).pop() || f.path

      // Deliveries are per-project (operator direction): the folder under
      // /Delivery-Queue/ maps to the project's own Slack channel.
      // DELIVERY_NOTIFY_CHANNEL_ID is an optional catch-all fallback.
      const resolved = await step.run(`resolve-${f.dropbox_id}`, () => resolveDeliveryChannel(f.path))
      const channel = resolved.channelId || DEFAULT_NOTIFY_CHANNEL

      // Generated caption siblings (.ttml/.vtt/.txt) — ours or hand-dropped.
      // Consume silently: a "pick a profile" prompt for a caption file is
      // noise, and our own uploads must never re-trigger the scanner.
      if (/\.(ttml|vtt|txt)$/i.test(name)) {
        await step.run(`consume-caption-${f.dropbox_id}`, () => markFileNotified(f.dropbox_id))
        continue
      }

      // SRT drop → generate TTML/VTT/TXT next to it (same basename)
      // instead of prompting for a transcode profile. Conversion happens
      // regardless of whether a channel resolved — the files ARE the point.
      if (isSrtFile(name)) {
        const result = await step.run(`convert-srt-${f.dropbox_id}`, async () => {
          try {
            const r = await processSrtFile({ path: f.path, sizeBytes: f.size_bytes })
            return { ok: true as const, generated: r.generated, cueCount: r.cueCount }
          } catch (err: any) {
            // Bad input gets one acknowledged notice. Provider/network failures
            // remain retryable and cannot consume the SRT event.
            if (!/^(no parseable cues in SRT|SRT too large)/.test(String(err.message))) throw err
            return { ok: false as const, error: err.message }
          }
        })
        if (result.ok) {
          converted++
          const siblings = result.generated
            .map((p: string) => `\`${p.split(/[\\/]/).pop()}\``)
            .join(', ')
          await step.run(`notify-caption-${f.dropbox_id}`, () => slackPost(
            channel,
            `Captions generated from ${name}`,
            [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text:
                    `:speech_balloon: *Captions generated* from \`${name}\` (${result.cueCount} cues)\n` +
                    `${siblings} dropped in the same folder.`,
                },
              },
            ], undefined, `caption-${f.dropbox_id}`,
          ))
        } else {
          await step.run(`notify-caption-error-${f.dropbox_id}`, () => slackPost(
            channel,
            `Caption conversion failed: ${name}`,
            [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `:warning: Couldn't convert \`${f.path}\` — ${result.error}`,
                },
              },
            ], undefined, `caption-error-${f.dropbox_id}`,
          ))
        }
        await step.run(`ack-caption-${f.dropbox_id}`, () => markFileNotified(f.dropbox_id))
        continue
      }

      if (!channel) {
        // Nowhere to post. Do NOT mark notified — leave the file to prompt
        // once its project channel is linked (or the fallback env is set).
        console.warn(
          `[delivery-scan] no Slack channel for ${f.path} — will retry (link the project channel or set DELIVERY_NOTIFY_CHANNEL_ID)`,
        )
        continue
      }

      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `:inbox_tray: *New delivery file${resolved.projectName ? ` — ${resolved.projectName}` : ''}*\n` +
              `:paperclip: \`${f.path}\` (${fmtBytes(f.size_bytes)})\n` +
              `Run \`/kit deliver ${f.path}\` to pick a delivery profile and start a transcode.`,
          },
        },
      ]
      const delivered = await step.run(`notify-file-${f.dropbox_id}`, () => completeDeliveryFileNotification({
        dropboxId: f.dropbox_id,
        post: () => slackPost(channel, `New file: ${name}`, blocks, undefined, `delivery-file-${f.dropbox_id}`),
        mark: markFileNotified,
      }))
      if (delivered) notified++
      else logger.warn(`[delivery-scan] Slack notification failed for ${f.path}; leaving eligible for retry`)
    }

    await step.run('heartbeat-success', () => recordCronSuccess('delivery-dropbox-scan'))
    return { notified, converted }
  },
)

// ─── Per-project specs/ folder poller ──────────────────────

export const deliverySpecsScan = inngest.createFunction(
  {
    id: 'delivery-specs-scan',
    name: 'Delivery — Per-project specs/ folder scan',
    retries: 1,
    triggers: [{ cron: '*/1 * * * *' }],
  },
  async ({ step }) => {
    await step.run('heartbeat', async () => {
      try { await recordCronAttempt('delivery-specs-scan') } catch {}
      return true
    })
    if (!process.env.DROPBOX_ACCESS_TOKEN && !process.env.DROPBOX_REFRESH_TOKEN) {
      return { skipped: 'no_dropbox_token' }
    }

    // One bounded tick: a DB lease serializes overlapping invocations, discovery
    // advances a persisted Dropbox cursor (bootstrap enumeration → delta), and
    // firing re-lists only projects with pending drops. Work is proportional to
    // NEW activity, never the whole /production tree — the fix for the every-
    // minute "operation was aborted due to timeout". See specs-watcher.ts.
    const result = await step.run('scan-specs-tick', () => runSpecsScanTick())
    await step.run('heartbeat-success', () => recordCronSuccess('delivery-specs-scan'))
    return result
  },
)

// ─── Job-state notifier ────────────────────────────────────

export const deliveryJobNotifier = inngest.createFunction(
  {
    id: 'delivery-job-notifier',
    name: 'Delivery — Notify Slack on job state changes',
    retries: 1,
    concurrency: { limit: 1 },
    triggers: [{ cron: '*/1 * * * *' }],
  },
  async ({ step }) => {
    const sb = createAdminClient()
    // Filter acknowledged terminal states BEFORE limiting, so old completions
    // cannot starve new jobs. Oldest candidates get serviced first.
    const { data: rows, error } = await sb.from('render_jobs').select('id')
      .in('status', ['claimed', 'processing', 'complete', 'failed'])
      .or('status.in.(claimed,processing),slack_notified_status.is.null,and(status.eq.complete,slack_notified_status.neq.complete),and(status.eq.failed,slack_notified_status.neq.failed)')
      .not('slack_channel', 'is', null).order('updated_at', { ascending: true }).limit(50)
    if (error) throw new Error('Render notification candidates unavailable')

    let posted = 0
    for (const candidate of rows || []) {
      const delivered = await step.run(`notify-job-${candidate.id}`, async () => {
        // Read current state inside the durable step, not an obsolete cron snapshot.
        const { data: job, error: readError } = await sb.from('render_jobs').select('*').eq('id', candidate.id).single()
        if (readError || !job) throw new Error('Render notification state unavailable')
        if (!job.slack_channel || !['claimed','processing','complete','failed'].includes(job.status)) return false
        if (['complete','failed'].includes(job.status) && job.slack_notified_status === job.status) return false
        const text = renderJobMessage(job)
        const ts = job.slack_message_ts || await slackPost(job.slack_channel, text, undefined, job.slack_thread_ts || undefined, `render-job-${job.id}`)
        // A recovered first-post receipt may contain an older job state.
        await slackUpdate(job.slack_channel, ts, text)
        const { error: saveError } = await sb.from('render_jobs').update({
          slack_message_ts: ts, slack_notified_status: job.status, slack_notified_at: new Date().toISOString(),
        }).eq('id', job.id).eq('status', job.status)
        if (saveError) throw new Error('Render notification acknowledgment could not be saved')
        return true
      })
      if (delivered) posted++
    }

    return { posted }
  },
)

function renderJobMessage(job: any): string {
  const profileName = job.profile_snapshot?.name || 'Delivery'
  const filename = job.output_filename || (job.source_files?.[0]?.path?.split(/[\\/]/).pop() ?? 'job')
  switch (job.status) {
    case 'claimed':
      return `:wrench: *${job.claimed_by}* picked up the job for \`${filename}\` — starting...`
    case 'processing':
      return (
        `:gear: *${profileName}* on \`${filename}\` — ${job.claimed_by}\n` +
        `\`${progressBar(job.progress_percent ?? 0)}\`\n` +
        `${job.progress_message || 'working...'}`
      )
    case 'complete': {
      const size = job.output_size_bytes ? ` (${fmtBytes(job.output_size_bytes)})` : ''
      const duration = job.duration_seconds ? ` — ${Math.round(job.duration_seconds)}s` : ''

      // Auto-QC results (worker ffprobed the output vs the profile).
      const autoQc = (job.qc_checklist_status || []) as { text: string; checked: boolean }[]
      let qcBlock = ''
      if (autoQc.length > 0) {
        const failed = autoQc.filter((c) => !c.checked)
        qcBlock = failed.length === 0
          ? '\n\n:white_check_mark: *QC passed* — output matches the spec.'
          : '\n\n:warning: *QC flagged:*\n' + failed.map((c) => `:x: ${c.text}`).join('\n')
      }

      // Manual QC checklist from the profile (operator verifies before sending).
      const qcList = (job.profile_snapshot?.qc_checklist || []) as string[]
      const manualBlock = qcList.length > 0
        ? '\n\n*Manual QC — verify before submission:*\n' + qcList.map((q) => `:black_square_button: ${q}`).join('\n')
        : ''

      return (
        `:white_check_mark: *Transcode complete*\n` +
        `Output: \`${filename}\`${size}${duration}\n` +
        `Worker: ${job.claimed_by || '?'}${qcBlock}${manualBlock}`
      )
    }
    case 'failed':
      return (
        `:x: *Transcode failed*\n` +
        `File: \`${filename}\`\n` +
        `Worker: ${job.claimed_by || '?'}\n` +
        `Error: ${job.error_message || '(no message)'}`
      )
    default:
      return `Delivery job ${job.id}: ${job.status}`
  }
}

// ─── Stale-worker sweep ────────────────────────────────────

export const deliveryStaleSweep = inngest.createFunction(
  {
    id: 'delivery-stale-sweep',
    name: 'Delivery — Reset jobs from stale workers',
    retries: 0,
    triggers: [{ cron: '*/1 * * * *' }],
  },
  async () => {
    const reset = await resetStaleJobs(60)
    return { reset }
  },
)
