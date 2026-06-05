// @ts-nocheck
/**
 * Detects "manage someone's Kit role" intent in a free-text message, so it
 * works conversationally in a DM / Assistant thread with Kit (where Slack
 * slash commands aren't available).
 *
 * Matches:
 *   - "make @Allyson a producer"           → set producer
 *   - "set @Allyson's role to producer"    → set producer
 *   - "give @Jared admin access"           → set founder (admin alias)
 *   - "promote @Sam to producer"           → set producer
 *   - "/kit role @Allyson producer" (typed literally) → set producer
 *   - "@Allyson role" / "what's @Allyson's role" → query (role: null)
 *
 * Requires an actual Slack user mention (<@U…>) so we always have a stable
 * target id. Name-only references ("make Allyson a producer") are left to
 * the orchestrator, which will ask for an @mention.
 */

export interface RoleIntent {
  targetSlackId: string
  /** Normalized role to set, or null when this is a "what's their role" query. */
  role: string | null
  isQuery: boolean
}

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/i
const ROLE_WORD_RE = /\b(producer|artist|admin|owner|founder|freelancer)\b/i
const INTENT_RE = /\b(role|tier|access|permission|permissions|make|set|promote|demote|change|assign|give)\b/i
const QUERY_RE = /\brole\b/i

function normalize(raw: string): string | null {
  const r = raw.toLowerCase()
  if (r === 'admin' || r === 'owner') return 'founder'
  if (['founder', 'producer', 'artist', 'freelancer'].includes(r)) return r
  return null
}

export function parseRoleIntent(text: string): RoleIntent | null {
  if (!text) return null
  const mention = text.match(MENTION_RE)
  if (!mention) return null
  const targetSlackId = mention[1]

  const roleWord = text.match(ROLE_WORD_RE)
  const hasIntent = INTENT_RE.test(text)

  if (roleWord && hasIntent) {
    const role = normalize(roleWord[1])
    if (role) return { targetSlackId, role, isQuery: false }
  }

  // "@Allyson role" / "what is @Allyson's role" with no role word → query
  if (!roleWord && QUERY_RE.test(text)) {
    return { targetSlackId, role: null, isQuery: true }
  }

  return null
}
