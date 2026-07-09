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
import { checkGateway, enforceAccess, failsafeArtistContext, type UserContext } from '../../../src/lib/inngest/access-control'

import { HARVEST_SYSTEM_PROMPT } from './prompts/harvest-system'
import { DROPBOX_SYSTEM_PROMPT } from './prompts/dropbox-system'
import { FRAMEIO_SYSTEM_PROMPT } from './prompts/frameio-system'
import { SLACK_SYSTEM_PROMPT } from './prompts/slack-system'
import { BOORDS_SYSTEM_PROMPT } from './prompts/boords-system'
import { STUDIO_KNOWLEDGE_SYSTEM_PROMPT } from './prompts/studio-knowledge-system'
import { DELIVERY_SYSTEM_PROMPT } from './prompts/delivery-system'
import { BRAIN_SYSTEM_PROMPT } from './prompts/brain-system'

const SYSTEM_PROMPTS: Record<string, string> = {
  harvest: HARVEST_SYSTEM_PROMPT,
  dropbox: DROPBOX_SYSTEM_PROMPT,
  frameio: FRAMEIO_SYSTEM_PROMPT,
  slack: SLACK_SYSTEM_PROMPT,
  boords: BOORDS_SYSTEM_PROMPT,
  studio_knowledge: STUDIO_KNOWLEDGE_SYSTEM_PROMPT,
  delivery: DELIVERY_SYSTEM_PROMPT,
  brain: BRAIN_SYSTEM_PROMPT,
}

const MAX_TURNS = 4 // safety cap on tool_use loop

export interface SpecialistContext {
  /** Slack channel the orchestrator was invoked in — enables brain-first retrieval. */
  channelId?: string | null
}

export async function runSpecialist(
  agentId: string,
  query: string,
  user: UserContext | null,
  context: SpecialistContext = {},
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
      // (e.g., slack:provision auto-invite, studio_knowledge brain-first
      // retrieval) read these.
      const payload: Record<string, unknown> = {
        ...llmPayload,
        slackUserId: llmPayload.slackUserId ?? user?.slackUserId,
        teamMemberId: llmPayload.teamMemberId ?? user?.teamMemberId,
        channelId: llmPayload.channelId ?? context.channelId ?? undefined,
      }

      let result: { success: boolean; data?: any; error?: string; message?: string }
      try {
        // Failsafe: if we couldn't resolve a UserContext, treat the request
        // as if it came from an artist. Never bypass enforcement — the
        // previous behavior of dispatching unwrapped when user=null would
        // hand every gated action to whoever Slack identified, which is
        // not the security posture we want.
        const effectiveUser =
          user ?? failsafeArtistContext(
            (payload.workspaceId as string) || process.env.KIT_DEFAULT_WORKSPACE_ID || '',
            (payload.slackUserId as string) || 'unknown',
          )
        // Gate BEFORE dispatch so a restricted *mutation* never runs its side
        // effect for an under-privileged user. (enforceAccess re-checks the
        // gateway and additionally field-filters successful results.)
        const gate = checkGateway(
          effectiveUser,
          agentId,
          action,
          payload.projectId as string | undefined,
        )
        if (!gate.allowed) {
          result = { success: false, error: gate.reason }
        } else {
          const dispatchResult = await dispatch(agentId, action, payload)
          result = await enforceAccess(effectiveUser, agentId, action, payload, dispatchResult)
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
