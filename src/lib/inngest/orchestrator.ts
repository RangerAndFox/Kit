// @ts-nocheck
/**
 * Kit Provision Orchestrator
 *
 * Inngest function that fans out to individual agent experts,
 * collects results, patches the Supabase project record, then
 * triggers the Slack agent to create the channel with all URLs.
 *
 * Flow:
 *   1. Post status message to triggering channel
 *   2. Phase 1 (parallel): Harvest, Dropbox, Frame.io agents
 *   3. Phase 2 (sequential): Slack agent (needs Phase 1 URLs)
 *   4. Phase 3: Stitch all links into Supabase
 *   5. Phase 4: Update status message with results
 */

import { inngest } from './client'
import { createAdminClient } from '@/lib/supabase/admin'
import { dispatch } from './agents/registry'

import type { AgentResult, ProvisionEventData } from './agents/types'

// ─── Slack notification helpers ─────────────────────────────

const SLACK_API = 'https://slack.com/api'

async function postSlackStatus(channelId: string, text: string): Promise<string | undefined> {
  if (!process.env.SLACK_BOT_TOKEN || !channelId) return undefined
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel: channelId, text }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null)
  if (!res) return undefined
  const json = await res.json()
  return json.ok ? json.ts : undefined
}

async function updateSlackStatus(channelId: string, ts: string, text: string) {
  if (!process.env.SLACK_BOT_TOKEN || !channelId || !ts) return
  await fetch(`${SLACK_API}/chat.update`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel: channelId, ts, text }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

// ─── The orchestrator function ──────────────────────────────

export const provisionProject = inngest.createFunction(
  {
    id: 'provision-project',
    name: 'Provision Project',
    retries: 0,
    triggers: [{ event: 'kit/project.provision' }],
  },
  async ({ event, step }) => {
    const data: ProvisionEventData = event.data
    const services = new Set(data.services)

    // ── Post initial status ───────────────────────────────────
    const statusTs = data.slackChannelId
      ? await step.run('post-status', async () => {
          const serviceNames = data.services
            .filter((s) => s !== 'slack')
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
          const list = serviceNames.join(', ')
          const text = `:rocket: *Provisioning "${data.projectName}"*\n\nActivating agents: ${list}${services.has('slack') ? ', Slack' : ''}\n_Each agent handles its domain independently..._`
          return postSlackStatus(data.slackChannelId!, text)
        })
      : undefined

    // ── Phase 1: Parallel agents ──────────────────────────────
    // Each dispatch() call uses the agent registry — the orchestrator
    // doesn't know or care about Harvest/Dropbox internals.

    const agentPayload = {
      projectId: data.projectId,
      projectName: data.projectName,
      client: data.client,
      projectCode: data.projectCode,
      projectType: data.projectType,
      startDate: data.startDate,
      targetDelivery: data.targetDelivery,
      briefSummary: data.briefSummary,
      budgetTotal: data.budgetTotal,
    }

    const harvestResult = services.has('harvest')
      ? await step.run('agent-harvest', { retries: 2 }, () =>
          dispatch('harvest', 'provision', agentPayload)
        )
      : { agent: 'harvest', action: 'provision', success: false, error: 'skipped' } as AgentResult

    const dropboxResult = services.has('dropbox')
      ? await step.run('agent-dropbox', { retries: 2 }, () =>
          dispatch('dropbox', 'provision', agentPayload)
        )
      : { agent: 'dropbox', action: 'provision', success: false, error: 'skipped' } as AgentResult

    const frameioResult = services.has('frameio')
      ? await step.run('agent-frameio', { retries: 2 }, () =>
          dispatch('frameio', 'provision', agentPayload)
        )
      : { agent: 'frameio', action: 'provision', success: false, error: 'skipped' } as AgentResult

    // ── Phase 2: Slack agent (needs other agent URLs) ─────────

    const slackResult = services.has('slack')
      ? await step.run('agent-slack', { retries: 1 }, () =>
          dispatch('slack', 'provision', {
            ...agentPayload,
            collectedLinks: {
              harvest: harvestResult.url,
              dropbox: dropboxResult.url,
              frameio: frameioResult.url,
            },
          })
        )
      : { agent: 'slack', action: 'provision', success: false, error: 'skipped' } as AgentResult

    // ── Phase 3: Stitch results into Supabase ─────────────────

    await step.run('stitch-results', async () => {
      const db = createAdminClient()
      const externalLinks: Record<string, string> = {}
      const patchFields: Record<string, unknown> = {}

      if (harvestResult.success && harvestResult.url) {
        externalLinks.harvest = harvestResult.url
        patchFields.harvest_project_id = Number(harvestResult.id) || null
      }
      if (dropboxResult.success && dropboxResult.url) {
        externalLinks.dropbox = dropboxResult.url
      }
      if (frameioResult.success && frameioResult.url) {
        externalLinks.frameio = frameioResult.url
      }
      if (slackResult.success) {
        externalLinks.slack = slackResult.url!
        patchFields.slack_channel_id = slackResult.id
      }

      if (Object.keys(externalLinks).length > 0) {
        patchFields.external_links = externalLinks
      }

      if (Object.keys(patchFields).length > 0) {
        await db.from('projects').update(patchFields).eq('id', data.projectId)
      }

      return { patched: Object.keys(externalLinks) }
    })

    // ── Phase 4: Update status message ────────────────────────

    await step.run('notify-complete', async () => {
      const results: Record<string, AgentResult> = {
        harvest: harvestResult,
        dropbox: dropboxResult,
        frameio: frameioResult,
        slack: slackResult,
      }

      const lines = Object.entries(results)
        .filter(([, r]) => r.error !== 'skipped')
        .map(([, r]) => {
          const icon = r.success ? ':white_check_mark:' : ':x:'
          const link = r.url ? ` — <${r.url}|Open>` : ''
          const err = !r.success && r.error ? ` — ${r.error}` : ''
          const agentName = r.agent.charAt(0).toUpperCase() + r.agent.slice(1)
          return `${icon} *${agentName} Agent*${link}${err}`
        })

      const summary = `:tada: *"${data.projectName}" is ready!*\n\n${lines.join('\n')}`

      if (data.slackChannelId && statusTs) {
        await updateSlackStatus(data.slackChannelId, statusTs, summary)
      }

      if (slackResult.success && slackResult.id && slackResult.id !== data.slackChannelId) {
        await postSlackStatus(slackResult.id, summary)
      }

      return { notified: true }
    })

    return {
      projectId: data.projectId,
      harvest: harvestResult,
      dropbox: dropboxResult,
      frameio: frameioResult,
      slack: slackResult,
    }
  }
)
