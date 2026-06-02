// @ts-nocheck
/**
 * Brain crons.
 *
 * Phase 4 ships the deadline-watch sweep — runs hourly, walks every
 * active brain's Watchlist section, posts in-channel flags for items
 * due within the configured lead window. Dedup via kit_actions so the
 * same watch item only flags once per window.
 *
 * Phase 5 will add the scavenger cron; Phase 6 the consolidator.
 *
 * Spec: KIT-BRAIN-SPEC.md §3.2
 */

import { inngest } from './client'
import { sweepDeadlines } from '../brain/flagger'
import { runScavengerForWorkspace } from '../brain/scavenger'
import { consolidateAllBrains } from '../brain/consolidate'

function postFromInngest(token: string) {
  return async ({ channelId, text }: { channelId: string; text: string }) => {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: channelId, text }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`slack chat.postMessage HTTP ${res.status}: ${body.slice(0, 200)}`)
    }
    const json = await res.json()
    if (!json.ok) {
      throw new Error(`slack chat.postMessage error: ${json.error}`)
    }
  }
}

/**
 * Phase 5 scavenger candidate-finder. Runs daily at 7am UTC (3am ET).
 * Walks every brain, builds candidates, queues them as pending
 * brain_scavenger_candidates rows. Does NOT DM — the DM dispatch
 * runs on the Bolt side (it needs the App handle) and picks up
 * whatever pending rows are sitting in the queue.
 *
 * Gated on KIT_BRAIN_SCAVENGER_ENABLED so the operator can keep it
 * off until they're ready for cross-channel context donation.
 */
export const brainScavengerScan = inngest.createFunction(
  {
    id: 'brain-scavenger-scan',
    name: 'Brain — daily scavenger candidate scan',
    retries: 1,
    triggers: [{ cron: '0 7 * * *' }], // 7am UTC
  },
  async ({ step, logger }) => {
    if (process.env.KIT_BRAIN_SCAVENGER_ENABLED !== 'true') {
      return { skipped: 'KIT_BRAIN_SCAVENGER_ENABLED is false' }
    }
    const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
    if (!workspaceId) return { skipped: 'missing KIT_DEFAULT_WORKSPACE_ID' }
    const result = await step.run('scavenger-scan', () => runScavengerForWorkspace({ workspaceId }))
    logger?.info?.('[brain-scavenger-scan] result', result)
    return result
  },
)

/**
 * Phase 6 consolidator. Runs nightly at 10am UTC (6am ET — after a full
 * day's activity has flowed in but before the team is back online).
 * Ages out stale watchlist items, compresses the decisions log, runs a
 * Haiku dedupe pass on bullet-heavy sections.
 *
 * Gated on KIT_BRAIN_CONSOLIDATOR_ENABLED so it stays off until the
 * operator confirms the brain has accumulated enough material for
 * consolidation to be useful (typically a few weeks of real traffic).
 */
export const brainConsolidate = inngest.createFunction(
  {
    id: 'brain-consolidate',
    name: 'Brain — nightly consolidator',
    retries: 0,
    triggers: [{ cron: '0 10 * * *' }], // 10am UTC
  },
  async ({ step, logger }) => {
    if (process.env.KIT_BRAIN_CONSOLIDATOR_ENABLED !== 'true') {
      return { skipped: 'KIT_BRAIN_CONSOLIDATOR_ENABLED is false' }
    }
    const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
    if (!workspaceId) return { skipped: 'missing KIT_DEFAULT_WORKSPACE_ID' }
    const result = await step.run('consolidate', () => consolidateAllBrains(workspaceId))
    logger?.info?.('[brain-consolidate] result', {
      ran: result.ran,
      touched: result.touched,
    })
    return { ran: result.ran, touched: result.touched }
  },
)

export const brainDeadlineSweep = inngest.createFunction(
  {
    id: 'brain-deadline-sweep',
    name: 'Brain — hourly watchlist deadline sweep',
    retries: 1,
    triggers: [{ cron: '0 * * * *' }], // every hour on the hour
  },
  async ({ step, logger }) => {
    if (process.env.KIT_BRAIN_DEADLINE_SWEEP_ENABLED !== 'true') {
      return { skipped: 'KIT_BRAIN_DEADLINE_SWEEP_ENABLED is false' }
    }
    const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
    const slackToken = process.env.SLACK_BOT_TOKEN
    if (!workspaceId || !slackToken) {
      return { skipped: 'missing KIT_DEFAULT_WORKSPACE_ID or SLACK_BOT_TOKEN' }
    }
    const leadDaysRaw = process.env.KIT_BRAIN_DEADLINE_LEAD_DAYS
    const leadDays = leadDaysRaw ? Number(leadDaysRaw) : 3

    const result = await step.run('sweep-deadlines', async () => {
      return sweepDeadlines({
        workspaceId,
        leadDays: Number.isFinite(leadDays) ? leadDays : 3,
        postFn: postFromInngest(slackToken),
      })
    })

    logger?.info?.('[brain-deadline-sweep] result', result)
    return result
  },
)
