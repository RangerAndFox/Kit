// @ts-nocheck
/**
 * Delivery pipeline cron jobs.
 *
 *   deliveryDropboxScan   — every 30s, polls /Delivery-Queue/ for new files,
 *                           posts a Slack notification with a "Pick Profile"
 *                           prompt for each newly-stable file.
 *
 *   deliveryJobNotifier   — every 30s, finds render_jobs that transitioned to
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
import { scanDeliveryQueue, markFileNotified } from '../delivery/dropbox-watcher'
import {
  scanProjectSpecs,
  markSpecsNotified,
  resolveProjectChannel,
  buildSpecsPromptBlocks,
} from '../delivery/specs-watcher'
import { pairSpecsFiles } from '../delivery/pairing'
import { progressBar } from '../delivery/progress-bar'
import { resetStaleJobs } from '../delivery/storage'

const SLACK_API = 'https://slack.com/api'
const DEFAULT_NOTIFY_CHANNEL = process.env.DELIVERY_NOTIFY_CHANNEL_ID || ''

async function slackPost(channel: string, text: string, blocks?: any[], threadTs?: string): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token || !channel) return null
  const body: any = { channel, text, mrkdwn: true }
  if (blocks) body.blocks = blocks
  if (threadTs) body.thread_ts = threadTs
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null)
  if (!res) return null
  const json = await res.json().catch(() => ({}))
  return json.ok ? json.ts : null
}

async function slackUpdate(channel: string, ts: string, text: string, blocks?: any[]): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token || !channel || !ts) return false
  const body: any = { channel, ts, text, mrkdwn: true }
  if (blocks) body.blocks = blocks
  const res = await fetch(`${SLACK_API}/chat.update`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null)
  if (!res) return false
  const json = await res.json().catch(() => ({}))
  return !!json.ok
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
    triggers: [{ cron: '*/1 * * * *' }], // every minute (Inngest min granularity)
  },
  async ({ step, logger }) => {
    if (!process.env.DROPBOX_ACCESS_TOKEN && !process.env.DROPBOX_REFRESH_TOKEN) {
      return { skipped: 'no_dropbox_token' }
    }
    if (!DEFAULT_NOTIFY_CHANNEL) {
      return { skipped: 'no_DELIVERY_NOTIFY_CHANNEL_ID' }
    }

    const newFiles = await step.run('scan', () => scanDeliveryQueue())
    if (newFiles.length === 0) return { scanned: 0 }

    for (const f of newFiles) {
      const name = f.path.split(/[\\/]/).pop() || f.path
      const blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `:inbox_tray: *New file in /Delivery-Queue/*\n` +
              `:paperclip: \`${f.path}\` (${fmtBytes(f.size_bytes)})\n` +
              `Run \`/kit deliver ${f.path}\` to pick a delivery profile and start a transcode.`,
          },
        },
      ]
      // Mark notified BEFORE posting so a Supabase write failure doesn't
      // cause a re-post on the next cron tick. We tolerate the edge case
      // where Slack post fails after the mark — operator will see the file
      // wasn't notified and can `/kit deliver <path>` manually.
      await markFileNotified(f.dropbox_id)
      await slackPost(DEFAULT_NOTIFY_CHANNEL, `New file: ${name}`, blocks)
    }

    return { notified: newFiles.length }
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
    if (!process.env.DROPBOX_ACCESS_TOKEN && !process.env.DROPBOX_REFRESH_TOKEN) {
      return { skipped: 'no_dropbox_token' }
    }

    const drops = await step.run('scan-specs', () => scanProjectSpecs())
    if (drops.length === 0) return { scanned: 0 }

    let posted = 0
    for (const drop of drops) {
      const project = await resolveProjectChannel(drop.safeName)
      const channel = project?.channelId || DEFAULT_NOTIFY_CHANNEL
      if (!channel) {
        // Nowhere to post — mark notified so we don't loop on it forever.
        await markSpecsNotified(drop.trigger.dropbox_id)
        continue
      }
      const pair = pairSpecsFiles({
        trigger: drop.trigger,
        videoFiles: drop.videoFiles,
        audioFiles: drop.audioFiles,
      })
      const blocks = buildSpecsPromptBlocks({ projectName: project?.name || drop.safeName, pair })

      // Mark before posting so a Slack failure doesn't re-loop (operator can
      // re-drop or use /kit deliver).
      await markSpecsNotified(drop.trigger.dropbox_id)
      const ts = await slackPost(channel, `New delivery source in ${drop.safeName}`, blocks)
      if (ts) posted++
    }
    return { drops: drops.length, posted }
  },
)

// ─── Job-state notifier ────────────────────────────────────

export const deliveryJobNotifier = inngest.createFunction(
  {
    id: 'delivery-job-notifier',
    name: 'Delivery — Notify Slack on job state changes',
    retries: 1,
    triggers: [{ cron: '*/1 * * * *' }],
  },
  async ({ step }) => {
    const sb = createAdminClient()

    // Jobs that are queued/claimed/processing/complete/failed AND haven't been
    // notified yet at the current status. Idempotency via slack_notified_status.
    const { data: rows } = await sb
      .from('render_jobs')
      .select(
        'id, status, slack_channel, slack_thread_ts, slack_message_ts, slack_notified_status, source_files, naming_fields, profile_snapshot, claimed_by, output_filename, output_size_bytes, duration_seconds, error_message, qc_checklist_status, progress_percent, progress_message',
      )
      .in('status', ['claimed', 'processing', 'complete', 'failed'])
      .order('updated_at', { ascending: false })
      .limit(50)

    let posted = 0
    for (const job of rows || []) {
      if (!job.slack_channel) continue

      // Terminal states announce once. 'processing' keeps updating in place so
      // the progress bar advances; 'claimed' refreshes to processing too.
      const terminal = job.status === 'complete' || job.status === 'failed'
      if (terminal && job.slack_notified_status === job.status) continue

      const text = renderJobMessage(job)

      if (!job.slack_message_ts) {
        // First message for this job — post it and remember its ts.
        const ts = await slackPost(job.slack_channel, text, undefined, job.slack_thread_ts || undefined)
        if (!ts) continue
        await sb
          .from('render_jobs')
          .update({
            slack_message_ts: ts,
            slack_notified_status: job.status,
            slack_notified_at: new Date().toISOString(),
          })
          .eq('id', job.id)
      } else {
        // Update the same message in place (live progress bar).
        const ok = await slackUpdate(job.slack_channel, job.slack_message_ts, text)
        if (!ok) continue
        await sb
          .from('render_jobs')
          .update({ slack_notified_status: job.status, slack_notified_at: new Date().toISOString() })
          .eq('id', job.id)
      }
      posted++
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
