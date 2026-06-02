// @ts-nocheck
/**
 * Brain Flagger — Phase 4 proactive flagging.
 *
 * Two checks, both posting flags in-channel with provenance:
 *
 *  1. Deadline watch (swept) — walks each brain's "Watchlist (deadlines
 *     & risks)" section, surfaces dated items within a lead window.
 *
 *  2. Mistake-catch (event-driven, narrow) — when a new message hits the
 *     ingest path, checks it against the brain's canonical IDs and the
 *     delivery date/spec lines. Posts a correction in-thread only when
 *     Haiku is highly confident (>= 0.85) that the message contains a
 *     value that contradicts the brain.
 *
 * Locked v1 (KIT-BRAIN-SPEC.md §3.2):
 *   - Mistake-catch scope is intentionally narrow. Superseded-decision
 *     detection and broader semantic "confusion catching" are deferred
 *     until this earns trust in real use.
 *
 * Spec: KIT-BRAIN-SPEC.md §3.2
 */

import Anthropic from '@anthropic-ai/sdk'
import {
  type Brain,
  type BrainBullet,
  type BrainProvenance,
  parseBrain,
} from './format'
import { createAdminClient } from '@/lib/supabase/admin'

// ─── Deadline watch ────────────────────────────────────────────────────────

export interface DueWatchItem {
  /** The bullet text as it appears in the brain. */
  text: string
  /** Parsed date the watch item references. */
  dueDate: Date
  /** Days until the due date (negative = past due). */
  daysUntil: number
  /** Section the bullet lives in. */
  section: string
  /** Provenance, for the in-channel flag's source line. */
  provenance?: BrainProvenance
  /** Stable id used to dedupe against kit_actions. */
  itemKey: string
}

const WATCHLIST_SECTIONS = new Set([
  'Watchlist (deadlines & risks)',
  'Watchlist',
])

// ISO date: 2026-06-22 (the seed path emits these)
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/

// Loose "Month DD" / "DD Month" patterns. Year inferred from current
// year when the date is in the future; rolls to next year if "Month DD"
// has already passed this year.
const MONTH_NAMES = [
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april',
  'may', 'jun', 'june', 'jul', 'july', 'aug', 'august',
  'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november',
  'dec', 'december',
]
const MONTH_DD_RE = new RegExp(
  `\\b(${MONTH_NAMES.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?\\b`,
  'i',
)

const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
}

export function parseDateFromBullet(text: string, now: Date = new Date()): Date | null {
  const iso = text.match(ISO_DATE_RE)
  if (iso) {
    const [, y, m, d] = iso
    const parsed = new Date(Number(y), Number(m) - 1, Number(d))
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  const md = text.match(MONTH_DD_RE)
  if (md) {
    const month = MONTH_INDEX[md[1].toLowerCase()]
    const day = Number(md[2])
    let year = md[3] ? Number(md[3]) : now.getFullYear()
    if (month === undefined || !Number.isFinite(day) || day < 1 || day > 31) return null
    let parsed = new Date(year, month, day)
    if (!md[3]) {
      // If no year supplied and the date already passed, roll forward.
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      if (parsed.getTime() < todayStart.getTime()) {
        parsed = new Date(year + 1, month, day)
      }
    }
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return null
}

export interface FindDueOpts {
  /** How far ahead we flag items. Defaults to 3 days. */
  leadDays?: number
  /** Reference "now" — for tests + cron determinism. */
  now?: Date
}

/**
 * Walk a parsed brain and return Watchlist items whose dates fall within
 * the lead window OR are already overdue. Deterministic; safe to test.
 */
export function findDueWatchlistItems(brain: Brain, opts: FindDueOpts = {}): DueWatchItem[] {
  const now = opts.now ?? new Date()
  const leadDays = opts.leadDays ?? 3
  const horizon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + leadDays)
  const out: DueWatchItem[] = []
  for (const section of brain.sections) {
    if (!WATCHLIST_SECTIONS.has(section.heading)) continue
    for (const bullet of section.bullets) {
      // Skip placeholder/system bullets — they're not real watch items.
      if (bullet.provenance?.src === 'system') continue
      if (/^no watchlist items/i.test(bullet.text)) continue
      const date = parseDateFromBullet(bullet.text, now)
      if (!date) continue
      if (date.getTime() > horizon.getTime()) continue
      const msPerDay = 24 * 60 * 60 * 1000
      const daysUntil = Math.floor((date.getTime() - now.getTime()) / msPerDay)
      out.push({
        text: bullet.text,
        dueDate: date,
        daysUntil,
        section: section.heading,
        provenance: bullet.provenance,
        itemKey: buildItemKey(brain, bullet),
      })
    }
  }
  return out
}

function buildItemKey(brain: Brain, bullet: BrainBullet): string {
  // Stable key per brain + bullet text. Used to dedupe against
  // kit_actions so we don't flag the same watch item twice in the
  // same lead window. Provenance src would be more stable, but it's
  // optional on bullets.
  const brainId = brain.frontmatter.brain_id || 'unknown'
  const hash = simpleHash(bullet.text.trim().toLowerCase())
  return `${brainId}:${hash}`
}

function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

// ─── Mistake-catch (event-driven, Haiku) ───────────────────────────────────

export interface MistakeCatch {
  /** The corrected/canonical value as it appears in the brain. */
  canonical: string
  /** The incorrect value spotted in the message (verbatim quote). */
  incorrect: string
  /** Which brain section the canonical fact lives in. */
  evidence_section: string
  /** Provenance of the canonical fact, if available. */
  provenance?: BrainProvenance
  /** Confidence 0..1; only >= 0.85 should be posted in-channel. */
  confidence: number
  /** One-sentence suggestion to post in-thread. */
  suggestion: string
}

export interface MistakeCatchResult {
  catches: MistakeCatch[]
  /** Skip reason when the writer did not run (no key, no candidate facts). */
  skipped?: string
}

/**
 * Pull the bullets that are eligible to be the "canonical" side of a
 * mistake-catch. Narrow scope: glossary + the date/spec lines from
 * Operating context.
 */
export function collectCanonicalFacts(brain: Brain): Array<{ text: string; section: string; provenance?: BrainProvenance }> {
  const out: Array<{ text: string; section: string; provenance?: BrainProvenance }> = []
  for (const s of brain.sections) {
    const heading = s.heading.toLowerCase()
    if (heading.startsWith('glossary')) {
      for (const b of s.bullets) {
        if (b.provenance?.src === 'system') continue
        out.push({ text: b.text, section: s.heading, provenance: b.provenance })
      }
    } else if (heading === 'operating context') {
      for (const b of s.bullets) {
        if (b.provenance?.src === 'system') continue
        // Only the "spec-like" bullets — dates, codes, formats.
        if (
          /\b\d{4}-\d{2}-\d{2}\b/.test(b.text) ||
          /\b(prores|h\.?264|h\.?265|aac|stereo|mono|5\.?1|wav|mp4|mov|fps|kbps|mbps|loudness|lufs|true\s*peak)\b/i.test(b.text) ||
          /\bdelivery\b/i.test(b.text) ||
          /\b(sku|asset id|project code)\b/i.test(b.text) ||
          /\b\d{4,}\b/.test(b.text) // long numeric — e.g. SKU
        ) {
          out.push({ text: b.text, section: s.heading, provenance: b.provenance })
        }
      }
    }
  }
  return out
}

const MISTAKE_SYSTEM_PROMPT = `You are the Brain Mistake-Catcher for Ranger & Fox, a video studio. Your scope is INTENTIONALLY NARROW.

You receive:
- A list of CANONICAL FACTS from a project's brain (glossary entries, delivery dates, broadcast specs).
- A NEW SLACK MESSAGE someone just posted in that project's channel.

Your only job: detect cases where the new message states a value that CONTRADICTS a canonical fact. This is the "you wrote SKU 44071, the at-risk item is 44017" catch class.

Output JSON ONLY in this shape:
{
  "catches": [
    {
      "canonical": "<exact text from the canonical facts list>",
      "incorrect": "<the contradictory value as quoted from the message>",
      "evidence_section": "<the section the canonical fact came from>",
      "confidence": <0.0..1.0>,
      "suggestion": "<one-sentence correction message to post in-thread, e.g. 'I think you meant asset ID 44017 — 44071 is a different SKU per our glossary.'>"
    }
  ]
}

RULES:
- Only flag clear contradictions of a SPECIFIC numeric/code/date/spec value. NOT vibes, NOT decisions, NOT opinions.
- Confidence calibration:
    0.9+ : message explicitly states a value that directly contradicts a canonical (e.g. wrong SKU number, wrong delivery date, wrong codec).
    0.7-0.9 : strong implication of contradiction but some ambiguity.
    < 0.7 : do not include — would be noise.
- If the message just MENTIONS a canonical fact correctly, return no catches.
- If the message is unrelated to canonical facts, return no catches.
- If the message asks a question ("is the SKU 44071?"), return no catches — questions aren't mistakes.
- Return {"catches": []} when in doubt. False positives erode trust.`

export interface CheckMistakeOpts {
  brain: Brain
  messageText: string
}

/**
 * Run a Haiku check on a message against the brain's canonical facts.
 * Returns only HIGH-confidence catches; callers should filter again
 * before posting in-channel.
 */
export async function checkMessageForMistakes(opts: CheckMistakeOpts): Promise<MistakeCatchResult> {
  const facts = collectCanonicalFacts(opts.brain)
  if (facts.length === 0) {
    return { catches: [], skipped: 'no_canonical_facts' }
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { catches: [], skipped: 'no_anthropic_api_key' }
  }
  const client = new Anthropic({ apiKey })

  const userPrompt = `CANONICAL FACTS (the source of truth for this project):
${facts.map((f, i) => `${i + 1}. [${f.section}] ${f.text}`).join('\n')}

NEW MESSAGE just posted in the channel:
"""
${opts.messageText}
"""

Decide whether the message contains a value that contradicts any canonical fact. Output JSON only.`

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: MISTAKE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const text = res.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()

  let parsed: any
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    console.error('[brain.flagger] mistake-catch JSON parse failed:', cleaned.slice(0, 200))
    return { catches: [], skipped: 'parse_error' }
  }
  const catches: MistakeCatch[] = []
  if (Array.isArray(parsed?.catches)) {
    for (const c of parsed.catches) {
      const canonical = String(c?.canonical || '').trim()
      const incorrect = String(c?.incorrect || '').trim()
      const evidence = String(c?.evidence_section || '').trim()
      const conf = Number(c?.confidence)
      const suggestion = String(c?.suggestion || '').trim()
      if (!canonical || !incorrect || !evidence || !suggestion) continue
      if (!Number.isFinite(conf)) continue
      const factMatch = facts.find((f) => f.text === canonical)
      catches.push({
        canonical,
        incorrect,
        evidence_section: evidence,
        provenance: factMatch?.provenance,
        confidence: Math.max(0, Math.min(1, conf)),
        suggestion,
      })
    }
  }
  return { catches }
}

// ─── kit_actions audit ─────────────────────────────────────────────────────

export interface KitActionInsertOpts {
  workspaceId: string
  projectId?: string | null
  type: 'brain_deadline_flag' | 'brain_mistake_catch'
  title: string
  description: string
  payload?: Record<string, unknown>
  confidence: number
  dedupKey?: string
  reasoning?: string
}

/**
 * Insert a kit_actions row for audit; returns the row id (or null when
 * the dedupKey collides with an existing recent suggestion). Mirrors
 * the existing sweep.ts pattern.
 */
export async function recordKitAction(opts: KitActionInsertOpts): Promise<string | null> {
  const sb = createAdminClient()
  if (opts.dedupKey) {
    const { data: existing } = await sb
      .from('kit_actions')
      .select('id')
      .eq('workspace_id', opts.workspaceId)
      .eq('type', opts.type)
      .eq('reasoning', `dedup:${opts.dedupKey}`)
      .in('status', ['suggested', 'in_progress', 'completed'])
      .limit(1)
    if (existing && existing.length > 0) return null
  }
  const { data, error } = await sb
    .from('kit_actions')
    .insert({
      workspace_id: opts.workspaceId,
      project_id: opts.projectId ?? null,
      type: opts.type,
      status: 'suggested',
      title: opts.title,
      description: opts.description,
      payload: opts.payload ?? null,
      confidence_score: opts.confidence,
      reasoning: opts.dedupKey ? `dedup:${opts.dedupKey}` : (opts.reasoning ?? null),
    })
    .select('id')
    .single()
  if (error) {
    console.error('[brain.flagger] kit_actions insert failed:', error.message)
    return null
  }
  return (data as any)?.id || null
}

// ─── Swept deadline-watch driver ───────────────────────────────────────────

export interface DeadlinePostFn {
  (opts: { channelId: string; text: string }): Promise<void>
}

export interface SweepDeadlinesOpts {
  workspaceId: string
  postFn: DeadlinePostFn
  leadDays?: number
  now?: Date
}

export interface SweepDeadlinesResult {
  scanned: number
  flagged: number
  deduped: number
}

/**
 * Walk every active brain in the workspace and post deadline flags to
 * each channel for items due within the lead window. Idempotent: dedup
 * keys ensure the same watch item isn't flagged twice in the same
 * (item, lead window) pair.
 */
export async function sweepDeadlines(opts: SweepDeadlinesOpts): Promise<SweepDeadlinesResult> {
  const sb = createAdminClient()
  const { data: rows } = await sb
    .from('brains')
    .select('id, project_id, slack_channel, markdown, workspace_id')
    .eq('workspace_id', opts.workspaceId)
  let scanned = 0
  let flagged = 0
  let deduped = 0
  for (const row of rows || []) {
    if (!row.slack_channel || !row.markdown) continue
    scanned++
    const brain = parseBrain(row.markdown)
    const due = findDueWatchlistItems(brain, { leadDays: opts.leadDays ?? 3, now: opts.now })
    for (const item of due) {
      const actionId = await recordKitAction({
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        type: 'brain_deadline_flag',
        title: `Deadline approaching: ${shortText(item.text, 80)}`,
        description: `Brain watchlist item in #${row.slack_channel} due in ${item.daysUntil} day(s).`,
        payload: {
          brain_id: row.id,
          section: item.section,
          due_date: item.dueDate.toISOString().slice(0, 10),
          days_until: item.daysUntil,
          text: item.text,
        },
        confidence: 1.0,
        dedupKey: item.itemKey,
      })
      if (!actionId) {
        deduped++
        continue
      }
      const emoji = item.daysUntil < 0 ? ':rotating_light:' : ':warning:'
      const when = item.daysUntil < 0
        ? `was due ${Math.abs(item.daysUntil)} day(s) ago`
        : item.daysUntil === 0
          ? 'is due today'
          : `is due in ${item.daysUntil} day(s)`
      const sourceLine = item.provenance?.src
        ? `\n_Source: \`${item.provenance.src}\` (${item.section})_`
        : ''
      try {
        await opts.postFn({
          channelId: row.slack_channel,
          text: `${emoji} *Watchlist:* ${item.text} — ${when}.${sourceLine}`,
        })
        flagged++
      } catch (err: any) {
        console.error('[brain.flagger] deadline post failed:', err?.message || err)
      }
    }
  }
  return { scanned, flagged, deduped }
}

function shortText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1).trimEnd() + '…'
}
