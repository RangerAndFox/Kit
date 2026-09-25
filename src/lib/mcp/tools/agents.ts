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
    'List Kit agents and capabilities permitted for the acting user bound into your signed credential. Supply workspace_id; caller-supplied user identities cannot change permissions.',
  schema: z.object({
    workspace_id: z.string().uuid().describe('Workspace ID to check access tiers'),
  }),
  annotations: { readOnlyHint: true },
  handler: async ({ workspace_id }, principal) => {
    if (!principal?.slackUserId || principal.workspaceId !== workspace_id) return fail('A signed acting identity in this workspace is required.')
    const manifest = getCapabilitiesManifest()
    const available = manifest.filter((a) => a.available)
    const offline = manifest.filter((a) => !a.available)

    // If we have user context, annotate which actions they can access
    let user: UserContext | null = null
    user = await resolveUserContext(principal.workspaceId, principal.slackUserId)
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
    'Dispatch an action to a specific agent. Use kit_list_agents first. Pass agent ID, action, payload and workspace_id. The signed acting identity determines access; user IDs and tiers supplied in arguments cannot elevate permissions.',
  schema: z.object({
    agent_id: z.string().describe('The agent to call (e.g., "harvest", "dropbox", "frameio", "slack")'),
    action: z.string().describe('The action to perform (e.g., "log_time", "search", "get_comments", "send_message")'),
    payload: z.record(z.any()).optional().default({}).describe('Action-specific parameters. Check the agent\'s capability descriptions for what each action expects.'),
    workspace_id: z.string().uuid().describe('Workspace ID for access control'),
  }),
  annotations: { readOnlyHint: false },
  handler: async ({ agent_id, action, payload, workspace_id }, principal) => {
    if (!principal?.slackUserId || principal.workspaceId !== workspace_id) return fail('A signed acting identity in this workspace is required.')
    // ── Resolve user context for access control ─────────────
    let user: UserContext | null = null
    user = await resolveUserContext(principal.workspaceId, principal.slackUserId)
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
      workspaceId: principal.workspaceId,
      workspace_id: principal.workspaceId,
      slackUserId: principal.slackUserId,
      slack_user_id: principal.slackUserId,
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
