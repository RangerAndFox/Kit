// @ts-nocheck
/**
 * Nightly cron — regenerate every project's summary document from the
 * latest notes + transcripts + actions and re-embed.
 *
 * Runs at 9am UTC (5am ET — quiet hours for the studio).
 * Gated by STUDIO_KNOWLEDGE_AUTO_SUMMARIZE_ENABLED so the cron can be
 * disabled without unregistering it.
 */

import { inngest } from './client'
import { regenerateAllProjectSummaries } from '../studio-knowledge/auto-summarize'

function ingestEnabled(): boolean {
  return process.env.STUDIO_KNOWLEDGE_AUTO_SUMMARIZE_ENABLED === 'true'
}

export const studioKnowledgeAutoSummarize = inngest.createFunction(
  {
    id: 'studio-knowledge-auto-summarize',
    name: 'Studio Knowledge — nightly project re-summarization',
    retries: 0,
    triggers: [{ cron: '0 9 * * *' }],
  },
  async ({ step, logger }) => {
    if (!ingestEnabled()) {
      return { skipped: 'STUDIO_KNOWLEDGE_AUTO_SUMMARIZE_ENABLED is false' }
    }
    const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
    if (!workspaceId) {
      return { skipped: 'KIT_DEFAULT_WORKSPACE_ID is not set' }
    }
    const stats = await step.run('regenerate-all', () =>
      regenerateAllProjectSummaries(workspaceId, { limit: 200 }),
    )
    return stats
  },
)
