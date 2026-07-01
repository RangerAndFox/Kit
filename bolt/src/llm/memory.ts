// @ts-nocheck
/**
 * Kit Conversation Memory
 *
 * In-memory store for conversation state per (team, channel, user).
 * 15-minute sliding TTL. Lost on Railway redeploy — that's fine for v1.
 */

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  ts: number
}

export interface ConversationState {
  messages: ConversationMessage[]
  awaitingClarification: boolean
  lastTurnAt: number
  createdAt: number
}

const MEMORY_TTL_MS = 15 * 60 * 1000
const MAX_MESSAGES_PER_CONVO = 20

const conversations = new Map<string, ConversationState>()

// Periodic eviction: expired entries were only overwritten on the next write
// from the same (team, channel, user) key, so the map grew by one entry per
// distinct conversation forever — a slow leak on an always-on process.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000
const sweeper = setInterval(() => {
  for (const [k, state] of conversations) {
    if (isExpired(state)) conversations.delete(k)
  }
}, SWEEP_INTERVAL_MS)
// Don't hold the process open just for the sweeper (tests, shutdown).
if (typeof sweeper.unref === 'function') sweeper.unref()

function key(teamId: string, channel: string, userId: string): string {
  return `${teamId}:${channel}:${userId}`
}

function freshState(): ConversationState {
  const now = Date.now()
  return { messages: [], awaitingClarification: false, lastTurnAt: now, createdAt: now }
}

function isExpired(state: ConversationState): boolean {
  return Date.now() - state.lastTurnAt > MEMORY_TTL_MS
}

export function loadConversation(
  teamId: string,
  channel: string,
  userId: string,
): ConversationState {
  const k = key(teamId, channel, userId)
  const existing = conversations.get(k)
  if (!existing || isExpired(existing)) {
    return freshState()
  }
  return existing
}

function getOrCreate(teamId: string, channel: string, userId: string): ConversationState {
  const k = key(teamId, channel, userId)
  const existing = conversations.get(k)
  if (existing && !isExpired(existing)) return existing
  const fresh = freshState()
  conversations.set(k, fresh)
  return fresh
}

function truncate(state: ConversationState): void {
  if (state.messages.length > MAX_MESSAGES_PER_CONVO) {
    state.messages.splice(0, state.messages.length - MAX_MESSAGES_PER_CONVO)
  }
}

export function appendUserTurn(
  teamId: string,
  channel: string,
  userId: string,
  content: string,
): void {
  const state = getOrCreate(teamId, channel, userId)
  state.messages.push({ role: 'user', content, ts: Date.now() })
  state.awaitingClarification = false
  state.lastTurnAt = Date.now()
  truncate(state)
}

export function appendAssistantTurn(
  teamId: string,
  channel: string,
  userId: string,
  content: string,
  awaitingClarification: boolean,
): void {
  const state = getOrCreate(teamId, channel, userId)
  state.messages.push({ role: 'assistant', content, ts: Date.now() })
  state.awaitingClarification = awaitingClarification
  state.lastTurnAt = Date.now()
  truncate(state)
}

export function hasPendingClarification(
  teamId: string,
  channel: string,
  userId: string,
): boolean {
  const k = key(teamId, channel, userId)
  const state = conversations.get(k)
  if (!state || isExpired(state)) return false
  return state.awaitingClarification
}

/** Test helper — never call from production code. */
export function resetMemoryForTest(): void {
  conversations.clear()
}
