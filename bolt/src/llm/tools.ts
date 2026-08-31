/**
 * Tool Generator
 *
 * Reads from the existing agent registry and produces Claude tool definitions
 * for two surfaces:
 *   - Orchestrator-level: one `ask_<agent>` tool per registered agent.
 *   - Specialist-level: one tool per (agent, capability) pair, namespaced.
 */

import {
  getAllAgents,
  getAgent,
} from '../../../src/lib/inngest/agents/registry'

export interface ClaudeTool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/**
 * Orchestrator tools — one per agent. Each takes a natural-language query
 * that the specialist sub-agent will translate into a specific action.
 */
export function buildOrchestratorTools(): ClaudeTool[] {
  return getAllAgents().map((agent) => ({
    name: `ask_${agent.id}`,
    description: `${agent.name} (${agent.domain}). ${agent.expertise}`.trim(),
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            `What you need from the ${agent.name}. Phrase it as a natural-language request — ` +
            `the specialist will figure out which action to call.`,
        },
      },
      required: ['query'],
    },
  }))
}

/**
 * Specialist tools — one per capability of a single agent. Names are
 * prefixed with `<agentId>_` to avoid collisions across specialists.
 *
 * Each tool's input_schema describes the payload via its description.
 * Claude reliably populates structured payloads from these descriptions
 * because the specialist sees only its own agent's tools.
 */
export function buildSpecialistTools(agentId: string): ClaudeTool[] {
  const agent = getAgent(agentId)
  if (!agent) {
    throw new Error(`buildSpecialistTools: unknown agent "${agentId}"`)
  }

  return agent.capabilities.map((cap) => {
    const inputDesc = cap.inputDescription
      ? `Expected fields: ${cap.inputDescription}`
      : 'Pass any relevant fields as object properties.'

    return {
      name: `${agent.id}_${cap.action}`,
      description: cap.description + (cap.mutates ? ' [WRITE]' : ' [READ-ONLY]'),
      input_schema: {
        type: 'object' as const,
        properties: {
          payload: {
            type: 'object',
            description: inputDesc,
            additionalProperties: true,
          },
        },
        required: ['payload'],
      },
    }
  })
}
