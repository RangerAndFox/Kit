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
    const jobs = Array.isArray(p.deadline_jobs) ? p.deadline_jobs : []
    const outputs = jobs
      .filter((j: any) => j.final_output || j.comp)
      .map((j: any) => (j.final_output ? `• *${j.comp}* → \`${j.final_output}\`` : `• *${j.comp}*`))
    const compLines = outputs.length ? `${outputs.join('\n')}\n` : ''

    const text = p.status === 'complete'
      ? `:white_check_mark: *Render complete* — \`${projectFile}\`\n` + compLines
      : `:x: *Render failed* — \`${projectFile}\`\n` +
        compLines +
        `${p.error_message || 'Unknown error'}\n` +
        `Fix the project (or check Deadline Monitor) and drop it in 03_RenderFarm again.`

    // Completed renders offer the delivery-spec follow-up: clicking the button
    // opens a spec-intake thread on this message (handled in submit-handler.ts).
    const blocks = p.status === 'complete'
      ? [
          { type: 'section', text: { type: 'mrkdwn', text } },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Add delivery specs' },
                action_id: 'kit_ae_add_specs',
                value: JSON.stringify({ parentId: p.id }),
              },
            ],
          },
        ]
      : undefined

    try {
      await slackClient.chat.postMessage({ channel: p.slack_channel, text, ...(blocks ? { blocks } : {}) })
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
