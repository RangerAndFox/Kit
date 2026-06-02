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
