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
        // Phase 1 stub. Phase 2 will look up the provenance for a matching
        // brain bullet (semantic match → return the bullet's <!-- src: ... -->
        // tag). For now, surface the capability so /kit brain why <claim>
        // can route here and get a useful "not yet" message.
        const claim = String(payload.claim || payload.query || '').trim()
        return {
          agent: 'brain',
          action,
          success: true,
          data: {
            claim,
            sources: [],
            message: 'Sourced answers ship in Phase 3. For now, open the channel canvas — every bullet carries an inline <!-- src: ... --> tag.',
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
