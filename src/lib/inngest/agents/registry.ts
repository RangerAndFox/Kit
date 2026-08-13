/**
 * Kit Agent Registry
 *
 * Central registry of all available agents. Kit queries this to:
 *   1. Know which agents are online (env vars present)
 *   2. Route requests to the right expert
 *   3. List capabilities for MCP tool discovery
 *
 * To add a new agent:
 *   1. Create src/lib/inngest/agents/{name}.ts
 *   2. Export an AgentDefinition
 *   3. Import and register it here
 */

import type { AgentDefinition, AgentResult } from './types'
import { harvestAgent } from './harvest'
import { dropboxAgent } from './dropbox'
import { frameioAgent } from './frameio'
import { slackAgent } from './slack'
import { boordsAgent } from './boords'
import { deliveryAgent } from './delivery'
import { studioKnowledgeAgent } from './studio-knowledge'
import { brainAgent } from './brain'

// ─── Registry ──────────────────────────────────────────────

const agents: AgentDefinition[] = [
  harvestAgent,
  dropboxAgent,
  frameioAgent,
  slackAgent,
  boordsAgent,
  deliveryAgent,
  studioKnowledgeAgent,
  brainAgent,
  // Add new agents here as they're built
]

const agentMap = new Map(agents.map((a) => [a.id, a]))

// ─── Public API ────────────────────────────────────────────

/** Get all registered agents */
export function getAllAgents(): AgentDefinition[] {
  return agents
}

/** Get agents that are currently available (env vars present) */
export function getAvailableAgents(): AgentDefinition[] {
  return agents.filter((agent) =>
    agent.requiredEnvVars.every((envVar) => !!process.env[envVar])
  )
}

/** Get a specific agent by ID */
export function getAgent(id: string): AgentDefinition | undefined {
  return agentMap.get(id)
}

/** Check if an agent is available (has required credentials) */
export function isAgentAvailable(id: string): boolean {
  const agent = agentMap.get(id)
  if (!agent) return false
  return agent.requiredEnvVars.every((envVar) => !!process.env[envVar])
}

/**
 * Find which agent(s) can handle a given action.
 * Returns all agents that declare the capability.
 */
export function findAgentsForAction(action: string): AgentDefinition[] {
  return agents.filter((agent) =>
    agent.capabilities.some((cap) => cap.action === action)
  )
}

/**
 * Dispatch an action to the right agent.
 * Looks up which agent owns this action, checks availability, and runs it.
 */
export async function dispatch(
  agentId: string,
  action: string,
  payload: Record<string, unknown>
): Promise<AgentResult> {
  const agent = agentMap.get(agentId)
  if (!agent) {
    return {
      agent: agentId,
      action,
      success: false,
      error: `Unknown agent: ${agentId}`,
    }
  }

  // Check env vars
  const missingVars = agent.requiredEnvVars.filter((v) => !process.env[v])
  if (missingVars.length > 0) {
    return {
      agent: agentId,
      action,
      success: false,
      error: `Agent "${agent.name}" is offline — missing: ${missingVars.join(', ')}`,
    }
  }

  // Check capability
  const capability = agent.capabilities.find((c) => c.action === action)
  if (!capability) {
    return {
      agent: agentId,
      action,
      success: false,
      error: `Agent "${agent.name}" doesn't know how to "${action}". It can: ${agent.capabilities.map((c) => c.action).join(', ')}`,
    }
  }

  // Run it
  return agent.handler(action, payload)
}

/**
 * Build a capabilities manifest that Kit can use for routing.
 * This is what Kit reads to know who to ask.
 */
export function getCapabilitiesManifest(): Array<{
  agentId: string
  agentName: string
  domain: string
  expertise: string
  available: boolean
  capabilities: Array<{ action: string; description: string; mutates: boolean }>
}> {
  return agents.map((agent) => ({
    agentId: agent.id,
    agentName: agent.name,
    domain: agent.domain,
    expertise: agent.expertise,
    available: agent.requiredEnvVars.every((v) => !!process.env[v]),
    capabilities: agent.capabilities.map((c) => ({
      action: c.action,
      description: c.description,
      mutates: c.mutates,
    })),
  }))
}
