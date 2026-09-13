import { appendAssistantTurn, appendUserTurn, loadConversation } from '../llm/memory'
import { guidanceRequestSchema } from './command-guidance'
import type { KitCommandName } from './command-catalog'

type Scope = { teamId: string; channelId: string; userId: string; threadTs?: string }
const conversationKey = (scope: Scope) => `guidance:${scope.channelId}:${scope.threadTs}`
const CLARIFY = 'guide:clarify'

export function rememberGuidanceClarification(scope: Scope): void {
  if (scope.threadTs) appendAssistantTurn(scope.teamId, conversationKey(scope), scope.userId, CLARIFY, false)
}

export function pendingGuidanceClarification(scope: Scope): boolean {
  if (!scope.threadTs) return false
  const messages = loadConversation(scope.teamId, conversationKey(scope), scope.userId).messages
  const last = messages[messages.length - 1]
  return last?.role === 'assistant' && last.content === CLARIFY
}

/** Only non-sensitive command names enter the existing 15-minute memory. */
export function rememberGuidanceInvitation(scope: Scope, command: KitCommandName): void {
  if (!scope.threadTs) return
  appendAssistantTurn(scope.teamId, conversationKey(scope), scope.userId, command, false)
}

export function pendingGuidance(scope: Scope): KitCommandName | null {
  if (!scope.threadTs) return null
  const messages = loadConversation(scope.teamId, conversationKey(scope), scope.userId).messages
  const last = messages[messages.length - 1]
  const parsed = guidanceRequestSchema.safeParse({ command: last?.role === 'assistant' ? last.content : null })
  return parsed.success ? parsed.data.command : null
}

export function clearGuidanceInvitation(scope: Scope): void {
  if (pendingGuidance(scope) || pendingGuidanceClarification(scope)) appendUserTurn(scope.teamId, conversationKey(scope), scope.userId, 'closed')
}

export function guidanceReplyIntent(text: string): boolean | null {
  const value = text.trim().replace(/[’]/g, "'").replace(/[.!?]+$/, '').trim()
  if (/^(?:yes(?: please)?|yep|yeah|sure|ok(?:ay)?|let's do (?:it|that)|go ahead|do (?:it|that)|start(?: privately)?)$/i.test(value)) return true
  if (/^(?:no(?: thanks| thank you)?|not now|cancel|never mind|nevermind)$/i.test(value)) return false
  return null
}

/** Same actor + team + channel + thread only. Not authorization to execute. */
export function consumeGuidanceReply(scope: Scope, text: string): { command: KitCommandName; start: boolean } | null {
  const command = pendingGuidance(scope)
  if (!command) return null
  clearGuidanceInvitation(scope)
  const intent = guidanceReplyIntent(text)
  return intent === null ? null : { command, start: intent }
}
