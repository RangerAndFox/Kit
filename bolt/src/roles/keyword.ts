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
 *
 * Matching is deliberately structural (verb → mention → role in sequence),
 * not bag-of-words: the old any-order matcher rewrote a user's tier from
 * messages like "make sure @Allyson the artist gets the final files".
 */

export interface RoleIntent {
  targetSlackId: string
  /** Normalized role to set, or null when this is a "what's their role" query. */
  role: string | null
  isQuery: boolean
}

const MENTION = '<@([UW][A-Z0-9]+)(?:\\|[^>]+)?>'
const ROLE = '(producer|artist|admin|owner|founder|freelancer)'

// Each pattern captures (targetSlackId, roleWord) from ONE structured phrase.
const SET_PATTERNS: RegExp[] = [
  // "make @X a producer" / "set @X's role to producer" / "promote @X to admin"
  new RegExp(
    `\\b(?:make|set|promote|demote|change|assign)\\s+${MENTION}(?:['’]s)?\\s*(?:\\b(?:role|tier|access)\\b\\s*)?(?:\\b(?:to|as|a|an)\\b\\s+)?${ROLE}\\b`,
    'i',
  ),
  // "give @X admin (access|role)" / "give @X producer permissions"
  new RegExp(
    `\\bgive\\s+${MENTION}\\s+(?:a\\s+|an\\s+)?${ROLE}\\b(?:\\s+(?:access|role|tier|permissions?))?`,
    'i',
  ),
  // "/kit role @X producer" typed literally / "role @X producer"
  new RegExp(`\\brole\\s+${MENTION}\\s+${ROLE}\\b`, 'i'),
]

const MENTION_RE = new RegExp(MENTION, 'i')
const ROLE_WORD_RE = new RegExp(`\\b${ROLE}\\b`, 'i')
const QUERY_RE = /\brole\b/i

function normalize(raw: string): string | null {
  const r = raw.toLowerCase()
  if (r === 'admin' || r === 'owner') return 'founder'
  if (['founder', 'producer', 'artist', 'freelancer'].includes(r)) return r
  return null
}

export function parseRoleIntent(text: string): RoleIntent | null {
  if (!text) return null

  for (const pattern of SET_PATTERNS) {
    const m = text.match(pattern)
    if (m) {
      const role = normalize(m[2])
      if (role) return { targetSlackId: m[1], role, isQuery: false }
    }
  }

  // "@Allyson role" / "what is @Allyson's role" with no role word → query
  const mention = text.match(MENTION_RE)
  if (mention && !ROLE_WORD_RE.test(text) && QUERY_RE.test(text)) {
    return { targetSlackId: mention[1], role: null, isQuery: true }
  }

  return null
}
