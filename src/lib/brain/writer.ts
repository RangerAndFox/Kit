// @ts-nocheck
/**
 * Brain Writer — decides whether a signal (channel message, transcript
 * snippet, note) changes the team's understanding of a project, and if so
 * proposes structured patches against the brain's section anchors.
 *
 * Two-stage:
 *   1. Cheap, deterministic classifier filters obvious noise (short
 *      messages, emoji, bot, etc.) so most channel chatter never reaches
 *      Claude. Cost-control before signal.
 *   2. Claude Haiku produces a JSON patch proposal. The prompt is
 *      grounded in the brain's current sections so the model patches
 *      against the existing structure rather than inventing new shapes.
 *
 * Spec: KIT-BRAIN-SPEC.md §3.0
 */

import Anthropic from '@anthropic-ai/sdk'
import { type Brain, type BrainPatch, type BrainProvenance } from './format'

export type SignalKind = 'message' | 'transcript' | 'note' | 'briefing'

export interface BrainSignal {
  kind: SignalKind
  text: string
  sourceRef: string                  // becomes the provenance `src:` tag
  author?: string                    // slack user id, "@brad", etc.
  occurredAt?: string                // ISO timestamp; used for "Recent decisions" stamping
  channelId?: string
}

export interface ProposedPatch {
  section: string
  operation: 'add' | 'update' | 'supersede'
  text: string
  confidence: number                 // 0..1
  match?: string
  reasoning?: string
}

export interface WriterResult {
  changes_understanding: boolean
  patches: ProposedPatch[]
  summary?: string
  /** Set when the classifier filtered the signal before reaching Claude. */
  classifier_skip_reason?: string
}

// ─── Cheap classifier ──────────────────────────────────────────────────────

/**
 * Returns a reason string when the signal should be skipped (no Claude call),
 * or null when it's worth examining. Cheap heuristics only — the writer is
 * the actual semantic gate.
 */
export function classifySignal(signal: BrainSignal): string | null {
  const text = (signal.text || '').trim()

  // Empty
  if (text.length === 0) return 'empty'

  // Slack join/leave/topic noise — check BEFORE length so we catch the
  // common "<@U…> has joined the channel" form even if it's > 25 chars.
  if (/has joined the channel|has left the channel|set the channel topic|set the channel purpose/i.test(text)) {
    return 'channel_event'
  }

  // Too short
  if (text.length < 25) return 'too_short'

  // Emoji- or punctuation-only
  if (/^[\p{Emoji_Presentation}\p{Punctuation}\s]+$/u.test(text)) return 'no_text_content'

  // URL-only — links by themselves aren't brain-worthy without context
  if (/^https?:\/\/\S+$/.test(text)) return 'url_only'

  return null
}

// ─── Haiku writer ──────────────────────────────────────────────────────────

const VALID_SECTIONS = [
  'Operating context',
  'Conventions & specs',
  'Open decisions',
  'Recent decisions (log)',
  'Watchlist (deadlines & risks)',
  'People & roles',
  'Glossary / canonical IDs',
] as const

const SYSTEM_PROMPT = `You are the Brain Writer for Ranger & Fox, a creative video studio. Your job is to read a new signal from a project's Slack channel and decide whether it CHANGES the team's operating understanding of that project.

Most chitchat does NOT change understanding. Be conservative. Only propose patches when the signal carries a concrete, durable fact, decision, deadline, owner, spec, or ID worth remembering.

You output JSON ONLY in this exact shape:
{
  "changes_understanding": <boolean>,
  "summary": "<one short sentence on why this changed (or did not change) the brain>",
  "patches": [
    {
      "section": "<one of the existing sections — see list below>",
      "operation": "add" | "update" | "supersede",
      "text": "<the new bullet text, concise — one sentence>",
      "confidence": <0.0..1.0>,
      "match": "<existing-bullet-substring (lower-case, only for update/supersede)>",
      "reasoning": "<why you chose this section and operation>"
    }
  ]
}

VALID SECTIONS (use these names exactly; no new sections):
- Operating context
- Conventions & specs
- Open decisions
- Recent decisions (log)
- Watchlist (deadlines & risks)
- People & roles
- Glossary / canonical IDs

GUIDELINES:
- "add": a brand-new fact. Default operation.
- "update": a bullet that already exists in the brain needs to be revised in place. Provide a "match" substring.
- "supersede": an old fact is now wrong; we want both visible (old struck through, new appended). Provide a "match" substring.

CONFIDENCE CALIBRATION:
- 0.9+ : the signal explicitly states the fact ("our delivery is June 20").
- 0.7-0.9 : strong implication ("Brad will own the audio mix" -> People & roles).
- 0.4-0.7 : possible but ambiguous. Will be SKIPPED at this stage.
- < 0.4 : do not include.

DECISIONS TO MAP TO "Recent decisions (log)":
- Choices about a specific deliverable ("switched to take 4")
- Sign-offs ("client approved the hero shot")

THINGS TO MAP TO "Glossary / canonical IDs":
- Asset/SKU/file IDs that get reused
- Canonical name spellings
- Codes ("project code STUDIO100", "SKU 44017")

THINGS TO MAP TO "Watchlist (deadlines & risks)":
- Dated events with consequences ("VO re-record by Friday or delivery slips")
- Identified risks

If the signal is chitchat, social, a question, or a status check — return {"changes_understanding": false, "patches": []}. Never invent facts.`

interface ProposeOptions {
  brain: Brain
  signal: BrainSignal
}

/**
 * Run a Haiku call to propose patches. Caller is expected to filter by
 * confidence and apply via store.applyPatches.
 */
export async function proposePatches(opts: ProposeOptions): Promise<WriterResult> {
  const skip = classifySignal(opts.signal)
  if (skip) {
    return {
      changes_understanding: false,
      patches: [],
      classifier_skip_reason: skip,
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    // No Claude key — the writer cannot run. Return a no-op rather than
    // throwing so the message handler stays silent in degraded mode.
    return {
      changes_understanding: false,
      patches: [],
      classifier_skip_reason: 'no_anthropic_api_key',
    }
  }

  const client = new Anthropic({ apiKey })
  const brainBody = renderBrainForPrompt(opts.brain)
  const userPrompt = buildUserPrompt(brainBody, opts.signal)

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 768,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const text = res.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')

  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()

  let parsed: WriterResult
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    console.error('[brain.writer] Haiku returned non-JSON:', cleaned.slice(0, 200))
    return { changes_understanding: false, patches: [], summary: 'parse_error' }
  }

  return sanitize(parsed)
}

function renderBrainForPrompt(brain: Brain): string {
  const lines: string[] = []
  lines.push(`Brain id: ${brain.frontmatter.brain_id}`)
  if (brain.frontmatter.project_code) lines.push(`Project code: ${brain.frontmatter.project_code}`)
  lines.push(`Revision: ${brain.frontmatter.revision ?? 0}`)
  lines.push('')
  for (const s of brain.sections) {
    lines.push(`## ${s.heading}`)
    for (const b of s.bullets) {
      lines.push(`- ${b.text}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}

function buildUserPrompt(brainBody: string, signal: BrainSignal): string {
  const occurred = signal.occurredAt ? `Occurred at: ${signal.occurredAt}` : ''
  const author = signal.author ? `Author: ${signal.author}` : ''
  const ref = `Source: ${signal.sourceRef}`
  return `Current brain for this channel:

${brainBody}

---

New signal (${signal.kind}):
${author}
${occurred}
${ref}

Signal text:
"""
${signal.text}
"""

Decide whether this changes the team's understanding. Output JSON only.`
}

function sanitize(parsed: any): WriterResult {
  const out: WriterResult = {
    changes_understanding: Boolean(parsed?.changes_understanding),
    patches: [],
    summary: typeof parsed?.summary === 'string' ? parsed.summary : undefined,
  }
  if (!Array.isArray(parsed?.patches)) return out
  for (const p of parsed.patches) {
    const section = String(p?.section || '').trim()
    const operation = String(p?.operation || 'add').toLowerCase()
    const text = String(p?.text || '').trim()
    const confidence = Number(p?.confidence)
    if (!section || !text) continue
    if (!Number.isFinite(confidence)) continue
    if (operation !== 'add' && operation !== 'update' && operation !== 'supersede') continue
    if (!VALID_SECTIONS.includes(section as any)) continue
    out.patches.push({
      section,
      operation: operation as 'add' | 'update' | 'supersede',
      text,
      confidence: Math.max(0, Math.min(1, confidence)),
      match: typeof p.match === 'string' ? p.match : undefined,
      reasoning: typeof p.reasoning === 'string' ? p.reasoning : undefined,
    })
  }
  return out
}

// ─── Filter + adapt for the store ──────────────────────────────────────────

const DEFAULT_AUTO_APPLY_THRESHOLD = 0.7

export interface FilteredPatches {
  applied: BrainPatch[]
  proposed: ProposedPatch[]   // raw proposals (for audit)
  skipped_low_conf: ProposedPatch[]
}

/**
 * Pick the patches that should auto-apply (high confidence), build
 * BrainPatch objects for the store with proper provenance attached.
 */
export function filterForAutoApply(opts: {
  result: WriterResult
  signal: BrainSignal
  threshold?: number
}): FilteredPatches {
  const threshold = opts.threshold ?? DEFAULT_AUTO_APPLY_THRESHOLD
  const applied: BrainPatch[] = []
  const skipped_low_conf: ProposedPatch[] = []
  for (const p of opts.result.patches) {
    if (p.confidence < threshold) {
      skipped_low_conf.push(p)
      continue
    }
    const provenance: BrainProvenance = {
      src: opts.signal.sourceRef,
      conf: round2(p.confidence),
      by: opts.signal.author,
    }
    applied.push({
      section: p.section,
      operation: p.operation,
      text: p.text,
      match: p.match,
      provenance,
    })
  }
  return { applied, proposed: opts.result.patches, skipped_low_conf }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
