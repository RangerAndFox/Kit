// @ts-nocheck
/**
 * Specialist sub-agent run loop.
 *
 * Each specialist:
 *   1. Receives a natural-language sub-query from the orchestrator.
 *   2. Picks exactly one tool (an action on its agent) based on its system prompt.
 *   3. Invokes registry.dispatch (gated by enforceAccess).
 *   4. Composes a brief structured summary as the response.
 *
 * The result string is what the orchestrator gets back as a tool_result.
 */

import { anthropic, SPECIALIST_MODEL } from './client'
import { buildSpecialistTools } from './tools'
import { dispatch } from '../../../src/lib/inngest/agents/registry'
import { enforceAccess, type UserContext } from '../../../src/lib/inngest/access-control'

import { HARVEST_SYSTEM_PROMPT } from './prompts/harvest-system'
import { DROPBOX_SYSTEM_PROMPT } from './prompts/dropbox-system'
import { FRAMEIO_SYSTEM_PROMPT } from './prompts/frameio-system'
import { SLACK_SYSTEM_PROMPT } from './prompts/slack-system'

const SYSTEM_PROMPTS: Record<string, string> = {
  harvest: HARVEST_SYSTEM_PROMPT,
  dropbox: DROPBOX_SYSTEM_PROMPT,
  frameio: FRAMEIO_SYSTEM_PROMPT,
  slack: SLACK_SYSTEM_PROMPT,
}

const MAX_TURNS = 4 // safety cap on tool_use loop

export async function runSpecialist(
  agentId: string,
  query: string,
  user: UserContext | null,
): Promise<string> {
  const systemPrompt = SYSTEM_PROMPTS[agentId]
  if (!systemPrompt) {
    return `Internal error: no system prompt configured for "${agentId}".`
  }

  const tools = buildSpecialistTools(agentId)
  const messages: Array<{ role: 'user' | 'assistant'; content: any }> = [
    { role: 'user', content: query },
  ]

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: SPECIALIST_MODEL,
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: tools as any,
      messages: messages as any,
    })

    if (response.stop_reason === 'tool_use') {
      const toolUseBlock = (response.content as any[]).find(
        (b) => b.type === 'tool_use',
      )
      if (!toolUseBlock) {
        return 'Internal error: tool_use stop_reason without tool_use block.'
      }

      const action = toolUseBlock.name.replace(`${agentId}_`, '')
      const llmPayload = (toolUseBlock.input?.payload || {}) as Record<string, unknown>

      // Inject identity context the LLM can't see. Agents that care
      // (e.g., slack:provision auto-invite) read these.
      const payload: Record<string, unknown> = {
        ...llmPayload,
        slackUserId: llmPayload.slackUserId ?? user?.slackUserId,
        teamMemberId: llmPayload.teamMemberId ?? user?.teamMemberId,
      }

      let result: { success: boolean; data?: any; error?: string; message?: string }
      try {
        if (user) {
          const dispatchResult = await dispatch(agentId, action, payload)
          result = await enforceAccess(user, agentId, action, payload, dispatchResult)
        } else {
          result = await dispatch(agentId, action, payload)
        }
      } catch (err: any) {
        result = { success: false, error: err?.message || String(err) }
      }

      // Surface raw failures in Railway logs so we can debug API errors
      // without having to puzzle them out of the LLM's paraphrase.
      if (!result.success) {
        console.error(
          `[${agentId}:${action}] failed: ${result.error || '(no message)'}`,
        )
      }

      messages.push({ role: 'assistant', content: response.content })
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseBlock.id,
            content: JSON.stringify(result),
            is_error: !result.success,
          },
        ],
      })
      continue
    }

    const textBlock = (response.content as any[]).find((b) => b.type === 'text')
    return textBlock?.text || `(no text returned by ${agentId} specialist)`
  }

  return `(${agentId} specialist hit max turns without resolving)`
}
