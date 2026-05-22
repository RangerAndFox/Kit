// @ts-nocheck
/**
 * Webhook Router
 * 
 * Routes incoming webhooks to the appropriate Managed Agent session.
 * This replaces the old BullMQ/worker pattern — webhooks no longer
 * do the work themselves, they just identify which agent should handle it.
 */

import { getSessionManager, type TriggerContext } from './session-manager'
import { getAgentRegistry } from './agent-registry'
import { AGENT_KEYS } from '../../../agents'

// ─── Route Definitions ───────────────────────────────────────

interface WebhookRoute {
  agentKey: string
  buildPrompt: (payload: Record<string, unknown>) => string
  persistent?: boolean
  contextKeyFn?: (payload: Record<string, unknown>) => string
}

const routes: Record<string, WebhookRoute> = {
  // Transcription services (Plaud, Otter, etc.)
  'transcript': {
    agentKey: AGENT_KEYS.CALL_PROCESSOR,
    buildPrompt: (payload) => {
      const transcript = payload.transcript as string || ''
      const source = payload.source as string || 'unknown'
      const attendees = (payload.attendees as string[])?.join(', ') || 'unknown'
      return `Process this meeting transcript from ${source}.\n\nAttendees: ${attendees}\n\nTranscript:\n${transcript}`
    },
  },

  // Render farm status updates
  'farm_status': {
    agentKey: AGENT_KEYS.PRODUCTION_MONITOR,
    buildPrompt: (payload) => {
      return `Render farm status update received: ${JSON.stringify(payload)}. Check if any active projects are affected and update farm_status table.`
    },
  },

  // Slack events (app_mention, DM, etc.)
  'slack_message': {
    agentKey: AGENT_KEYS.SLACK_PARTICIPANT,
    persistent: true,
    contextKeyFn: (payload) => `slack-channel-${payload.channel_id || 'dm'}`,
    buildPrompt: (payload) => {
      const user = payload.user_name as string || 'someone'
      const text = payload.text as string || ''
      const channel = payload.channel_name as string || 'DM'
      return `Message from ${user} in #${channel}: ${text}`
    },
  },

  // Project management tool sync
  'project_ops': {
    agentKey: AGENT_KEYS.PRODUCTION_MONITOR,
    buildPrompt: (payload) => {
      return `Project operations event: ${JSON.stringify(payload)}. Sync the relevant data to our Supabase tables.`
    },
  },

  // Scheduled health sweep (cron trigger)
  'scheduled_sweep': {
    agentKey: AGENT_KEYS.PRODUCTION_MONITOR,
    buildPrompt: (payload) => {
      const workspaceId = payload.workspace_id as string || ''
      return `Run a full health sweep for workspace ${workspaceId}. Check all active projects for budget, schedule, and feedback health. Create actions for any issues found.`
    },
  },
}

// ─── Router ──────────────────────────────────────────────────

export async function routeWebhook(
  routeKey: string,
  trigger: TriggerContext
): Promise<{ sessionId: string; status: string; events?: any[] }> {
  const route = routes[routeKey]
  if (!route) {
    throw new Error(`Unknown webhook route: ${routeKey}`)
  }

  const registry = getAgentRegistry()
  const sessionManager = getSessionManager()

  const agentId = await registry.getAgentId(route.agentKey)
  const environmentId = await registry.getEnvironmentId()

  if (!agentId || !environmentId) {
    throw new Error(`Agent or environment not registered: ${route.agentKey}`)
  }

  const prompt = route.buildPrompt(trigger.payload)

  if (route.persistent && route.contextKeyFn) {
    // Long-lived session (e.g., Slack participant)
    const contextKey = route.contextKeyFn(trigger.payload)
    const sessionId = await sessionManager.getOrCreateSession(
      contextKey,
      agentId,
      environmentId,
      trigger
    )
    
    // Send message to existing session
    const events = await sessionManager.sendFollowUp(sessionId, prompt)
    return { sessionId, status: 'message_sent', events }
  }

  // One-shot session
  const result = await sessionManager.dispatch(
    agentId,
    environmentId,
    trigger,
    prompt
  )

  return { sessionId: result.sessionId, status: result.status }
}
