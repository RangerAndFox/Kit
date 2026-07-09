// @ts-nocheck
/**
 * Slack notifier for After Effects render-farm jobs.
 *
 * The Deadline relay (and the kit-worker fleet) only write status to Supabase;
 * this cron announces terminal states in the job's Slack channel. Idempotent
 * via the slack_notified_status column (migration 020) — each status change is
 * announced at most once.
 */

import { createAdminClient } from '../supabase/admin'

export interface AeNotifyResult {
  announced: number
}

export async function notifyAeRenderCompletions(slackClient: any): Promise<AeNotifyResult> {
  const sb = createAdminClient()

  const { data: parents } = await sb
    .from('render_jobs')
    .select('id, status, ae_project_path, ae_comp, output_path, error_message, slack_channel, slack_notified_status, deadline_jobs, chunk_count, render_backend')
    .eq('job_type', 'ae_render')
    .in('status', ['complete', 'failed'])
    .not('slack_channel', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(20)

  let announced = 0
  for (const p of parents || []) {
    if (p.slack_notified_status === p.status) continue

    const projectFile = (p.ae_project_path || '').split(/[\\/]/).pop() || 'project'
    const comps = Array.isArray(p.deadline_jobs)
      ? p.deadline_jobs.map((j: any) => j.comp).filter(Boolean)
      : []
    const compLine = comps.length ? `Comps: ${comps.map((c: string) => `*${c}*`).join(', ')}\n` : ''

    const text = p.status === 'complete'
      ? `:white_check_mark: *Render complete* — \`${projectFile}\`\n` +
        compLine +
        `Output: \`<projectDir>\\render\\<comp>\\\``
      : `:x: *Render failed* — \`${projectFile}\`\n` +
        compLine +
        `${p.error_message || 'Unknown error'}\n` +
        `Fix the project (or check Deadline Monitor) and drop it in 04_RenderFarm again.`

    try {
      await slackClient.chat.postMessage({ channel: p.slack_channel, text })
      await sb
        .from('render_jobs')
        .update({
          slack_notified_status: p.status,
          slack_notified_at: new Date().toISOString(),
        })
        .eq('id', p.id)
      announced++
    } catch (err: any) {
      console.error(`[ae-notify] post failed for ${p.id}: ${err?.data?.error || err.message}`)
    }
  }

  return { announced }
}
