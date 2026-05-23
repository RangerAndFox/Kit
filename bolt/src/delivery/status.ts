// @ts-nocheck
/**
 * Status renderers for delivery jobs + workers.
 */

import { listRecentJobs, listWorkers } from '../../../src/lib/delivery/storage'

const STATUS_EMOJI: Record<string, string> = {
  pending: ':hourglass_flowing_sand:',
  claimed: ':wrench:',
  processing: ':gear:',
  complete: ':white_check_mark:',
  failed: ':x:',
  cancelled: ':no_entry_sign:',
  online: ':large_green_circle:',
  offline: ':white_circle:',
  busy: ':large_blue_circle:',
  opted_out: ':large_yellow_circle:',
}

export async function renderJobsStatusBlocks() {
  const jobs = await listRecentJobs(10)
  if (jobs.length === 0) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: '_No recent transcode jobs._' } }]
  }
  const lines = jobs.map((j) => {
    const emoji = STATUS_EMOJI[j.status] || ':grey_question:'
    const file = j.source_files?.[0]?.path?.split(/[\\/]/).pop() || '(no source)'
    const prog =
      j.status === 'processing' && j.progress_percent
        ? ` — ${j.progress_percent}%`
        : ''
    return `${emoji} \`${j.id.slice(0, 8)}\` *${j.status}*${prog} — ${file}${j.claimed_by ? ` (${j.claimed_by})` : ''}`
  })
  return [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }]
}

export async function renderWorkersStatusBlocks() {
  const workers = await listWorkers()
  if (workers.length === 0) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: '_No workers registered yet._' } }]
  }
  const lines = workers.map((w) => {
    const emoji = STATUS_EMOJI[w.status] || ':grey_question:'
    const role = w.role === 'primary' ? '*[primary]*' : '_[fallback]_'
    const cpu = w.cpu_usage_percent != null ? `CPU ${Math.round(w.cpu_usage_percent)}%` : ''
    const disk = w.disk_free_gb != null ? `Disk ${Math.round(w.disk_free_gb)}GB free` : ''
    const bits = [emoji, w.hostname, role, w.status, cpu, disk].filter(Boolean).join(' • ')
    return bits
  })
  return [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }]
}
