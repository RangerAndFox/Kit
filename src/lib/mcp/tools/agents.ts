// @ts-nocheck
/**
 * Kit Agent Router — MCP Tools
 *
 * Exposes the agent system to Kit's LLM layer so it can:
 *   1. Discover which agents are available and what they can do
 *   2. Dispatch actions to the right agent
 *
 * Access control is enforced at two levels:
 *   - Gateway: blocks entire actions based on user tier
 *   - Field-level: strips sensitive data from results
 *
 * Kit reads the capabilities manifest at the start of a conversation
 * and uses it to decide who to ask for any given request.
 */

import { z } from 'zod'
import { ok, fail } from '../helpers'
import {
  getCapabilitiesManifest,
  dispatch,
} from '@/lib/inngest/agents/registry'
import {
  resolveUserContext,
  checkGateway,
  filterResultData,
  type UserContext,
  type AccessTier,
} from '@/lib/inngest/access-control'
import type { KitTool } from '../types'

// ─── kit_list_agents ────────────────────────────────────────

export const listAgents: KitTool = {
  name: 'kit_list_agents',
  description:
    'List all available Kit agents and their capabilities. Call this at the start of a conversation to know which experts are online and what they can do. Each agent is a domain expert in a specific external service. Optionally pass slack_user_id and workspace_id to get a tier-filtered view showing only what this user can access.',
  schema: z.object({
    workspace_id: z.string().uuid().describe('Workspace ID to check access tiers'),
    slack_user_id: z.string().min(1).describe('Slack user ID to resolve access tier'),
  }),
  annotations: { readOnlyHint: true },
  handler: async ({ workspace_id, slack_user_id }) => {
    const manifest = getCapabilitiesManifest()
    const available = manifest.filter((a) => a.available)
    const offline = manifest.filter((a) => !a.available)

    // If we have user context, annotate which actions they can access
    let user: UserContext | null = null
    user = await resolveUserContext(workspace_id, slack_user_id)
    if (!user) return fail('The requesting Slack user is not authorized in this workspace.')

    return ok({
      user_tier: user?.tier || 'unknown',
      available: available.map((a) => ({
        id: a.agentId,
        name: a.agentName,
        domain: a.domain,
        expertise: a.expertise,
        actions: a.capabilities.map((c) => {
          const access = checkGateway(user, a.agentId, c.action)
          return {
            action: c.action,
            description: c.description,
            mutates: c.mutates,
            accessible: access.allowed,
            ...(access.allowed ? {} : { restricted_reason: access.reason }),
          }
        }),
      })),
      offline: offline.map((a) => ({
        id: a.agentId,
        name: a.agentName,
        domain: a.domain,
        reason: 'Missing credentials',
      })),
    })
  },
}

// ─── kit_ask_agent ──────────────────────────────────────────

export const askAgent: KitTool = {
  name: 'kit_ask_agent',
  description:
    'Dispatch an action to a specific agent. Use kit_list_agents first to know which agents and actions are available. Each agent is an expert in its domain — Harvest knows time/money, Dropbox knows files, Frame.io knows reviews, Slack knows communication. Pass the agent ID, action name, and a payload with the required fields. Include workspace_id and slack_user_id for access control — some actions and data are restricted by tier.',
  schema: z.object({
    agent_id: z.string().describe('The agent to call (e.g., "harvest", "dropbox", "frameio", "slack")'),
    action: z.string().describe('The action to perform (e.g., "log_time", "search", "get_comments", "send_message")'),
    payload: z.record(z.any()).optional().default({}).describe('Action-specific parameters. Check the agent\'s capability descriptions for what each action expects.'),
    workspace_id: z.string().uuid().describe('Workspace ID for access control'),
    slack_user_id: z.string().min(1).describe('Slack user ID of the person making the request'),
  }),
  annotations: { readOnlyHint: false },
  handler: async ({ agent_id, action, payload, workspace_id, slack_user_id }) => {
    // ── Resolve user context for access control ─────────────
    let user: UserContext | null = null
    user = await resolveUserContext(workspace_id, slack_user_id)
    if (!user) return fail('The requesting Slack user is not authorized in this workspace.')

    // ── Gateway check (Kit level) ───────────────────────────
    const projectId = payload.projectId as string | undefined
    const gatewayCheck = checkGateway(user, agent_id, action, projectId)
    if (!gatewayCheck.allowed) {
      return fail(gatewayCheck.reason || "Sorry, that's restricted information.")
    }

    // ── Dispatch to agent ───────────────────────────────────
    // The model cannot elevate its own knowledge visibility. Unknown callers
    // fail closed to the lowest tier; resolved admins may retrieve founder docs.
    const dispatchPayload = {
      ...payload,
      requesterTier: user.tier,
    }
    const result = await dispatch(agent_id, action, dispatchPayload)

    if (!result.success) {
      return fail(result.error || `Agent "${agent_id}" action "${action}" failed`)
    }

    // ── Field-level filtering (Agent level) ─────────────────
    if (result.data) {
      result.data = filterResultData(result.data, user, projectId)
    }

    return ok(result, result.message || `${result.agent}:${result.action} completed`)
  },
}
