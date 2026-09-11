import { randomUUID } from 'node:crypto'
import { inngest } from './client'
import { deliverOutbox, outboxDb, type OutboxRow } from '../control-center/outbox'
import { runProjectControlSync, requireCompletedSync } from './project-control-sync'
import { queueBehanceDraft } from '../archive/behance-store'

interface SlackResult {
  ok?: boolean
  ts?: string
  has_more?: boolean
  response_metadata?: { next_cursor?: string }
  messages?: Array<{ ts?: string; metadata?: { event_type?: string; event_payload?: { delivery_id?: string } } }>
}

async function slack(method: string, body: object): Promise<SlackResult> {
  if (!process.env.SLACK_BOT_TOKEN) throw new Error('Slack not configured')
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error('Slack unavailable')
  return response.json()
}

async function reconcile(row: OutboxRow): Promise<{ state: 'found'; ts: string } | { state: 'absent' | 'unknown' }> {
  let cursor: string | undefined
  for (let page = 0; page < 5; page++) {
    const result = await slack('conversations.history', {
      channel: row.payload.channel, oldest: String(Date.parse(row.created_at) / 1000 - 60),
      limit: 100, include_all_metadata: true, ...(cursor ? { cursor } : {}),
    })
    if (!result.ok) return { state: 'unknown' }
    const found = result.messages?.find(m => m.metadata?.event_type === 'kit_control_delivery' && m.metadata.event_payload?.delivery_id === row.id)
    if (found?.ts) return { state: 'found', ts: found.ts }
    cursor = result.response_metadata?.next_cursor
    if (!result.has_more && !cursor) return { state: 'absent' }
    if (!cursor) return { state: 'unknown' }
  }
  return { state: 'unknown' }
}

async function dispatchAction(row: OutboxRow): Promise<void> {
  const db = outboxDb()
  const { data: project, error } = await db.from('projects').select('id,project_code').eq('id', row.project_id).eq('workspace_id', row.payload.workspaceId).single()
  if (error || !project) throw new Error('Project no longer available')
  if (row.payload.action === 'reconcile_project') {
    if (!project.project_code) throw new Error('Project has no stable code')
    const updates = await Promise.all([
      db.from('project_control_bindings').update({ sync_status: 'pending' }).eq('project_id', row.project_id),
      db.from('project_control_canvases').update({ sync_status: 'pending' }).eq('project_id', row.project_id).neq('canvas_type', 'notesAndFeedback'),
    ])
    if (updates.some(result => result.error)) throw new Error('Could not checkpoint requested refresh')
    requireCompletedSync(await runProjectControlSync(undefined, { force: true, projectCode: project.project_code }))
  } else if (row.payload.action === 'retry_behance') {
    const { data: job, error: jobError } = await db.from('behance_draft_jobs').select('archive_job_id,status').eq('id', row.payload.jobId).eq('project_id', row.project_id).eq('workspace_id', row.payload.workspaceId).single()
    if (jobError || !job) throw new Error('Draft no longer available')
    // A prior attempt may already have queued or completed this job.
    if (!['failed', 'retryable'].includes(job.status)) return
    await queueBehanceDraft(job.archive_job_id, `control-center:${row.payload.actor}`)
  } else throw new Error('Unknown control action')
}

export async function drainControlOutbox(): Promise<{ processed: number }> {
  const started = Date.now()
  const db = outboxDb()
  const { data: rows, error } = await db.from('kit_control_outbox').select('id').in('status', ['pending', 'retry', 'processing']).lte('next_attempt_at', new Date().toISOString()).order('next_attempt_at').limit(10)
  if (error) throw new Error('Outbox read failed')
  let processed = 0
  for (const candidate of rows || []) {
    if (Date.now() - started > 120_000) break
    const token = randomUUID()
    const { data, error: claimError } = await db.rpc('claim_control_outbox', { p_id: candidate.id, p_token: token })
    if (claimError) throw new Error('Outbox claim failed')
    const row = data?.[0] as OutboxRow | undefined
    if (!row) continue
    await deliverOutbox(row, {
      async markStarted() {
        const { data: saved, error: markError } = await db.from('kit_control_outbox').update({ send_started: true }).eq('id', row.id).eq('lease_token', token).gt('lease_until', new Date().toISOString()).select('id').single()
        if (markError || !saved) throw new Error('Delivery checkpoint lost')
      },
      reconcile: () => reconcile(row),
      async post() {
        const result = await slack('chat.postMessage', { channel: row.payload.channel, text: row.payload.text, unfurl_links: false, unfurl_media: false,
          metadata: { event_type: 'kit_control_delivery', event_payload: { delivery_id: row.id } } })
        return { ok: result.ok === true, ts: result.ts }
      },
      action: () => dispatchAction(row),
      async finish(status, error, ts) {
        const result = await db.rpc('finish_control_outbox', { p_id: row.id, p_token: token, p_status: status, p_error: error || null, p_slack_ts: ts || null })
        if (result.error || result.data !== true) throw new Error('Outbox completion checkpoint failed')
      },
    })
    processed++
  }
  return { processed }
}

export const controlOutboxDelivery = inngest.createFunction({
  id: 'control-outbox-delivery', name: 'Kit — durable control requests and alerts',
  concurrency: 1, retries: 3, triggers: [{ cron: '* * * * *' }],
}, async ({ step }) => step.run('drain', drainControlOutbox))
