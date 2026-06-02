// @ts-nocheck
/**
 * Brain agent — Phase 1 actions.
 *
 *   get             load a brain by id or by slack_channel
 *   seed            build (or fetch) the initial brain for a channel
 *   why             stub for provenance lookup (Phase 2 will wire this fully)
 *   refresh_canvas  no-op here; the Bolt /kit brain command does the Slack
 *                   side. This action exists so the registry surfaces the
 *                   capability for routing.
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
          if (!loaded) return { agent: 'brain', action, success: false, error: `brain ${brainId} not found` }
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
        // The canvas write itself happens in the Bolt layer (it has the
        // authenticated `app` reference). This action exists so the
        // registry can announce the capability; the actual call lives in
        // bolt/src/handlers/commands.ts (/kit brain).
        return {
          agent: 'brain',
          action,
          success: true,
          message: 'Canvas refresh is performed by the /kit brain Slack command.',
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
    "Owns the per-channel project brain: a versioned markdown knowledgebase mirrored to a Slack canvas. Use this to load a brain, seed one for a channel that doesn't have one yet, or ask why a fact in the brain is what it is. Brain sections are also embedded into the studio_knowledge RAG so the studio_knowledge agent can quote from them.",
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
      description: '[Phase 1 stub] Return the provenance source(s) for a claim. In Phase 1 this returns a placeholder pointing at the canvas; full provenance lookup ships in Phase 3.',
      inputDescription: 'claim (string)',
      mutates: false,
    },
    {
      action: 'refresh_canvas',
      description: 'Trigger a brain canvas refresh in Slack. In Phase 1 the actual canvas write is performed by the /kit brain command handler; this action is a no-op placeholder.',
      inputDescription: 'channelId (string)',
      mutates: true,
    },
  ],
  handler: handle,
}
