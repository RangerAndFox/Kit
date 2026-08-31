/**
 * Anthropic SDK singleton.
 *
 * Two named exports — `anthropic` (the client) and `LLM_TIMEOUT_MS` (used by
 * orchestrator and specialist for per-call timeouts).
 */

import Anthropic from '@anthropic-ai/sdk'

if (!process.env.ANTHROPIC_API_KEY) {
  // Don't crash at import time — the bot might still want to start without
  // the LLM layer wired up. Log a warning. Calls will fail later.
  console.warn('[Kit] ANTHROPIC_API_KEY not set — Kit conversational layer will fail')
}

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 30_000,
  maxRetries: 2,
})

/** Hard ceiling for any single Anthropic call, used as a fallback timeout */
export const LLM_TIMEOUT_MS = 30_000

/** Models — pinned IDs per design doc */
export const ORCHESTRATOR_MODEL = 'claude-opus-4-7' as const
export const SPECIALIST_MODEL = 'claude-haiku-4-5-20251001' as const
