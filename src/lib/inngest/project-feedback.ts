import { inngest } from './client'
import { createAdminClient } from '../supabase/admin'
import { feedbackEnabled, syncStoredFeedback } from '../project-feedback/sync'

// One scheduler. Per-source DB claims protect across deployments and retries.
// Up to five due files per tick, hourly per file; provider Retry-After is honored.
export const projectFeedbackSync = inngest.createFunction({
  id: 'project-feedback-sync', name: 'Project asset comments → Notes & Feedback', retries: 1,
  concurrency: { limit: 1 }, triggers: [{ cron: '*/5 * * * *' }],
}, async ({ step }) => {
  if (!feedbackEnabled()) return { skipped: true }
  const ids = await step.run('due', async () => {
    const result = await createAdminClient().from('project_feedback_sources').select('id')
      .lte('next_attempt_at', new Date().toISOString()).order('next_attempt_at').limit(5)
      .or(`lease_expires_at.is.null,lease_expires_at.lt.${new Date().toISOString()}`)
    if (result.error) throw new Error('feedback_queue_unavailable')
    return (result.data || []).map(r => r.id as string)
  })
  const results = []
  for (const id of ids) results.push(await step.run(`sync-${id}`, () => syncStoredFeedback(id)))
  return { processed: results.length, issues: results.filter(r => 'error' in r && r.error).length }
})
