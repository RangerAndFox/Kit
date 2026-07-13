// @ts-nocheck
/**
 * Kit's orchestrator run loop.
 *
 * Inputs: a Slack message + user context + conversation key.
 * Outputs: a reply string + whether Kit is now awaiting clarification.
 *
 * Loop:
 *   1. Build messages from conversation history + new user message.
 *   2. Call Sonnet with KIT_SYSTEM_PROMPT and orchestrator tools.
 *   3. If stop_reason is tool_use, run the specialist for that agent,
 *      append tool_result, and continue the loop.
 *   4. When stop_reason is end_turn, return the assistant text.
 */

import { anthropic, ORCHESTRATOR_MODEL } from './client'
import { buildOrchestratorTools } from './tools'
import { runSpecialist } from './specialist'
import { KIT_SYSTEM_PROMPT } from './prompts/kit-system'
import { currentDateLine } from './date-context'
import {
  loadConversation,
  appendUserTurn,
  appendAssistantTurn,
} from './memory'
import type { UserContext } from '../../../src/lib/inngest/access-control'

const MAX_TURNS = 6 // orchestrator may chain multiple specialist calls in one Slack reply

export interface OrchestratorRequest {
  teamId: string
  channel: string
  userId: string
  user: UserContext | null
  message: string
  /**
   * Per-request context header ("[You are talking to …][This channel is …]").
   * Injected into the CURRENT API call only — never stored in conversation
   * memory, where it used to accumulate one copy per stored turn (~10
   * duplicates per call at the history cap, crowding out real history).
   */
  contextPreamble?: string
}

export interface OrchestratorResult {
  reply: string
  awaitingClarification: boolean
}

export async function runOrchestrator(
  req: OrchestratorRequest,
): Promise<OrchestratorResult> {
  // Pull existing conversation, then record the new user turn
  loadConversation(req.teamId, req.channel, req.userId)
  appendUserTurn(req.teamId, req.channel, req.userId, req.message)

  const tools = buildOrchestratorTools()

  // Re-load to include the just-appended user turn
  const fresh = loadConversation(req.teamId, req.channel, req.userId)
  const messages: Array<{ role: 'user' | 'assistant'; content: any }> = fresh.messages.map(
    (m) => ({ role: m.role, content: m.content }),
  )

  // Prefix the context preamble onto the CURRENT user turn only (the stored
  // history stays clean).
  if (req.contextPreamble && messages.length > 0) {
    const last = messages[messages.length - 1]
    if (last.role === 'user' && typeof last.content === 'string') {
      last.content = `${req.contextPreamble}\n\n${last.content}`
    }
  }

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: ORCHESTRATOR_MODEL,
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: KIT_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
        // Uncached (changes daily) so the static prompt above stays cacheable.
        { type: 'text', text: currentDateLine() },
      ],
      tools: tools as any,
      messages: messages as any,
    })

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = (response.content as any[]).filter(
        (b) => b.type === 'tool_use',
      )

      messages.push({ role: 'assistant', content: response.content })

      const toolResults: any[] = []
      for (const block of toolUseBlocks) {
        const agentId = block.name.replace(/^ask_/, '')
        const query = block.input?.query || ''
        const summary = await runSpecialist(agentId, query, req.user, { channelId: req.channel })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: summary,
        })
      }

      messages.push({ role: 'user', content: toolResults })
      continue
    }

    const textBlock = (response.content as any[]).find((b) => b.type === 'text')
    const reply = textBlock?.text || "I'm not sure how to answer that."

    const awaitingClarification = isAskingClarification(reply)

    appendAssistantTurn(
      req.teamId,
      req.channel,
      req.userId,
      reply,
      awaitingClarification,
    )

    return { reply, awaitingClarification }
  }

  // Hitting the turn cap is a failure, not a pending question — marking it
  // awaitingClarification made Kit consume the user's next un-mentioned
  // channel message for 15 minutes.
  const fallback = "I went around in circles on that one — try rephrasing?"
  appendAssistantTurn(req.teamId, req.channel, req.userId, fallback, false)
  return { reply: fallback, awaitingClarification: false }
}

/**
 * Heuristic: Kit is asking for clarification only when the reply ends with `?`
 * AND contains a disambiguation keyword. Generic questions like
 * "How can I help?" don't count — they're conversation openers, not
 * pending clarifications waiting on a specific user reply.
 *
 * "or" only counts in the disambiguation shape "… X or Y?" (exactly one word
 * on each side, at the end) — bare "or" anywhere used to arm the trap on
 * sign-offs like "Anything else, or is that all?".
 */
function isAskingClarification(reply: string): boolean {
  const trimmed = reply.trim()
  if (!trimmed.endsWith('?')) return false
  if (/\b(which|whose|whom|did you mean|clarify|what project|which one)\b/i.test(trimmed)) {
    return true
  }
  return /\w+\s+or\s+\w+\?$/i.test(trimmed)
}
