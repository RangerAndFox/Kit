// @ts-nocheck
/**
 * Detect "shot list" intent in @Kit messages.
 *
 * Triggers on the substrings: "shot list", "shotlist", "shot-list", "shots".
 * Excludes the word "shots" when it's clearly unrelated (e.g., "shots of espresso")
 * by requiring a co-occurring verb like create/make/add/edit/build/give me/show.
 */

const SHOT_KEYWORDS = /\b(shot\s*list|shotlist|shot-list)\b/i
const SHOTS_WITH_VERB =
  /\bshots\b.{0,40}\b(create|make|add|edit|build|generate|give|show)\b|\b(create|make|add|edit|build|generate|give|show).{0,40}\bshots\b/i

export function isShotListTrigger(text: string): boolean {
  if (!text) return false
  if (SHOT_KEYWORDS.test(text)) return true
  if (SHOTS_WITH_VERB.test(text)) return true
  return false
}

/**
 * Extract the script body from a shot-list trigger message. Heuristic:
 *   - If the message contains "from this:" or "from:" or a colon followed by content, take everything after.
 *   - Otherwise return the full message (the LLM is robust to trigger words mixed in).
 */
export function extractScriptBody(text: string): string {
  const match = text.match(/(?:from\s+(?:this\s*)?:|:)\s*([\s\S]+)$/i)
  if (match && match[1].trim().length > 20) return match[1].trim()
  return text.trim()
}
