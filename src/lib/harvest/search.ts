/**
 * Fuzzy project matching for Harvest.
 *
 * People refer to projects three ways — the number code ("2611"), the
 * client ("crunchyroll"), or the name / keywords ("magic quadrant",
 * "meera") — and rarely with exact spelling or separators. Legacy Harvest
 * projects also carry composite names ("2611 | Microsoft | AI in Meetings
 * (Meera)") while new ones keep code/client/name in their own fields, so
 * the scorer looks across all three fields of both shapes and ignores
 * separator/spacing differences ("crunchy roll", "2611_MSFT_AI-in-Meetings").
 *
 * Pure module — no API calls — so it's unit-testable; harvest/client.ts
 * feeds it the live project list.
 */

export interface MatchableHarvestProject {
  name: string
  code: string
  client?: { id: number; name: string }
}

const STOPWORDS = new Set([
  'on', 'the', 'for', 'and', 'a', 'an', 'of', 'to', 'in', 'at', 'with',
  'project', 'proj', 'worked', 'work', 'working', 'hours', 'hour', 'hrs', 'h',
  'i', 'we', 'my', 'did', 'do', 'today', 'yesterday', 'this', 'that',
])

/** Lowercase and strip everything but letters and digits. */
export function squash(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function tokenize(query: string): string[] {
  return (query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t))
}

function words(s: string): Set<string> {
  return new Set(
    (s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  )
}

/**
 * Score how well a free-form query matches one project. 0 = no signal.
 * Codes are the strongest signal, then name words, then client. Pure.
 */
export function scoreProjectMatch(query: string, p: MatchableHarvestProject): number {
  const tokens = tokenize(query)
  if (tokens.length === 0) return 0

  const name = (p.name || '').toLowerCase()
  const code = (p.code || '').toLowerCase()
  const client = (p.client?.name || '').toLowerCase()
  const nameWords = words(name)
  const clientWords = words(client)
  const nameSquash = squash(name)
  const codeSquash = squash(code)
  const clientSquash = squash(client)

  let score = 0
  let matchedTokens = 0

  for (const t of tokens) {
    let tokenScore = 0
    const numeric = /^\d{3,}[a-z]?$/.test(t)

    if (numeric) {
      // "2611" — the number code, wherever it lives (code field or a
      // legacy "2611 | ..." composite name, including "2611-MSFT" codes).
      if (t === code || t === codeSquash) tokenScore = 100
      else if (codeSquash.includes(t)) tokenScore = 60
      else if (nameWords.has(t)) tokenScore = 50
      else if (nameSquash.includes(t)) tokenScore = 40
    } else {
      if (nameWords.has(t)) tokenScore = 12
      else if (t.length >= 4 && name.includes(t)) tokenScore = 8
      if (clientWords.has(t)) tokenScore = Math.max(tokenScore, 10)
      else if (t.length >= 4 && clientSquash.includes(t)) tokenScore = Math.max(tokenScore, 6)
      if (t.length >= 4 && codeSquash.includes(t)) tokenScore = Math.max(tokenScore, 8)
    }

    if (tokenScore > 0) matchedTokens++
    score += tokenScore
  }

  // Separator-insensitive whole-query hit: "crunchy roll" → "crunchyroll".
  const qs = squash(tokens.join(''))
  if (qs.length >= 5 && (nameSquash.includes(qs) || clientSquash.includes(qs))) {
    score += 30
  }

  // A query where most tokens found nothing is probably about a different
  // project that shares one word — dampen instead of accumulating noise.
  if (matchedTokens === 0) return 0
  if (matchedTokens / tokens.length < 0.5 && score < 40) return 0

  return score
}

/**
 * Rank projects against a query. Returns:
 *   []            — no plausible match
 *   [one]         — a single dominant winner (safe to auto-select)
 *   [a, b, ...]   — plausible candidates, best first (caller disambiguates)
 */
export function rankProjects<T extends MatchableHarvestProject>(query: string, projects: T[]): T[] {
  const scored = projects
    .map((p) => ({ p, score: scoreProjectMatch(query, p) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) return []
  const [top, second] = scored
  if (!second || top.score >= second.score * 2 || top.score - second.score >= 25) {
    return [top.p]
  }
  return scored.slice(0, 5).map((s) => s.p)
}
