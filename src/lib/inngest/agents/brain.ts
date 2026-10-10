/**
 * Brain agent — Phase 1 actions.
 *
 *   get             load a brain by id or by slack_channel
 *   seed            build (or fetch) the initial brain for a channel
 *   why             retrieve source-backed provenance from channel knowledge
 *   refresh_canvas  retired; compatibility requests return a clear explanation
 *
 * Spec: KIT-BRAIN-SPEC.md §3.1, §6
 */

import type { AgentDefinition, AgentResult } from './types'
import { getBrainById, getBrainByChannel } from '../../brain/store'
import { seedBrainForChannel } from '../../brain/seed'

async function handle(action: string, payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    switch (action) {
      case 'get': {
        const brainId = (payload.brainId as string) || ''
        const channelId = (payload.channelId as string) || (payload.slackChannelId as string) || ''
        const workspaceId = (payload.workspaceId as string) || process.env.KIT_DEFAULT_WORKSPACE_ID || ''
        if (brainId) {
          const loaded = await getBrainById(brainId)
          if (!workspaceId || !loaded || loaded.row.workspace_id !== workspaceId) return { agent: 'brain', action, success: false, error: 'Brain not found in this workspace' }
          return { agent: 'brain', action, success: true, data: { row: loaded.row, brain: loaded.brain } }
        }
        if (channelId && workspaceId) {
          const loaded = await getBrainByChannel(workspaceId, channelId)
          if (!loaded) return { agent: 'brain', action, success: false, error: `no brain for channel ${channelId}` }
          return { agent: 'brain', action, success: true, data: { row: loaded.row, brain: loaded.brain } }
        }
        return { agent: 'brain', action, success: false, error: 'brainId OR (channelId + workspaceId) required' }
      }

      case 'seed': {
        const channelId = (payload.channelId as string) || (payload.slackChannelId as string) || ''
        const workspaceId = (payload.workspaceId as string) || process.env.KIT_DEFAULT_WORKSPACE_ID || ''
        const author = (payload.author as string) || 'system'
        if (!channelId || !workspaceId) {
          return { agent: 'brain', action, success: false, error: 'channelId + workspaceId required' }
        }
        const result = await seedBrainForChannel({ workspaceId, slackChannelId: channelId, author })
        return {
          agent: 'brain',
          action,
          success: true,
          data: {
            created: result.created,
            row: result.loaded.row,
            brain: result.loaded.brain,
          },
        }
      }

      case 'why': {
        const claim = String(payload.claim || payload.query || '').trim()
        const channelId = (payload.channelId as string) || (payload.slackChannelId as string) || ''
        const workspaceId = (payload.workspaceId as string) || process.env.KIT_DEFAULT_WORKSPACE_ID || ''
        if (!claim) {
          return { agent: 'brain', action, success: false, error: 'claim (string) required' }
        }
        if (!channelId || !workspaceId) {
          return { agent: 'brain', action, success: false, error: 'channelId + workspaceId required' }
        }
        const { brainFirstRetrieve, formatSourcesLine } = await import('../../brain/retrieve')
        const first = await brainFirstRetrieve({
          query: claim,
          channelId,
          workspaceId,
          limit: 5,
          visibilityTiers: ['team'],
        })
        if (first.provenances.length === 0) {
          return {
            agent: 'brain',
            action,
            success: true,
            data: {
              claim,
              sources: [],
              message: `I couldn't trace "${claim}" to a specific source in this channel's brain. Either the brain doesn't know it yet, or it was added by hand without a provenance tag.`,
            },
          }
        }
        return {
          agent: 'brain',
          action,
          success: true,
          data: {
            claim,
            sources: first.provenances,
            sources_line: formatSourcesLine(first.provenances),
            message: `Closest matches:\n${first.provenances
              .map((p) => `• \`${p.src}\` — ${p.section || '?'} — "${(p.text || '').slice(0, 80)}"`)
              .join('\n')}`,
          },
        }
      }

      case 'refresh_canvas': {
        // Keep a truthful compatibility response for old action requests.
        return {
          agent: 'brain',
          action,
          success: false,
          error: 'The separate Brain tab is retired. Project memory is still active; producers/admins can read it privately with /kit brain. Use Overview and Notes & Feedback for team updates.',
        }
      }

      default:
        return { agent: 'brain', action, success: false, error: `unknown action: ${action}` }
    }
  } catch (err: any) {
    return { agent: 'brain', action, success: false, error: err?.message || String(err) }
  }
}

export const brainAgent: AgentDefinition = {
  id: 'brain',
  name: 'Brain',
  domain: "the channel's living team brain — operating context, decisions, watchlist, glossary",
  expertise:
    "Owns per-channel project memory: a versioned markdown knowledgebase used for retrieval, not a separate Slack tab. Use this to load memory, seed it for a channel, or trace a fact to its source. Brain sections are embedded into studio_knowledge RAG. Existing visibility and access rules still apply.",
  requiredEnvVars: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  capabilities: [
    {
      action: 'get',
      description: 'Load a brain by brain id, or by (workspaceId, channelId). Returns the parsed structured brain + the brains row.',
      inputDescription: 'brainId (string) OR channelId+workspaceId (strings)',
      mutates: false,
    },
    {
      action: 'seed',
      description: 'Build the initial brain for a channel from its linked project + recent notes. Idempotent: returns the existing brain if one is already present. Persists the markdown + embeds each section.',
      inputDescription: 'channelId (Slack channel id, required); workspaceId (optional; defaults to KIT_DEFAULT_WORKSPACE_ID)',
      mutates: true,
    },
    {
      action: 'why',
      description: 'Find source-backed provenance for a claim in this channel. Explicitly reports when no source can be traced.',
      inputDescription: 'claim (string)',
      mutates: false,
    },
  ],
  handler: handle,
}
