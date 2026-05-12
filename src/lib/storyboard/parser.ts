// @ts-nocheck
/**
 * Script-to-Frames parsers.
 *
 * All parsers produce a uniform { label, sound, action } shape that maps
 * 1:1 onto the Boords frame model. The caller picks an extraction mode
 * or lets us auto-detect.
 */

import type { BoordsFrame } from '../boords/client'

export type ExtractionMode = 'auto' | 'sentence' | 'table' | 'ai'

export interface ParsedScript {
  frames: BoordsFrame[]
  modeUsed: 'sentence' | 'table' | 'ai'
  detectedTable: boolean
}

// ─── Sentence split ────────────────────────────────────────────

/**
 * Sentence-per-frame split. Each sentence becomes a frame's voiceover
 * (Boords `sound` field). Visuals are left blank for the producer to
 * fill in — sensible default since we don't have visual cues in plain
 * text.
 *
 * Splits on terminal punctuation (.!?) followed by whitespace, while
 * preserving common abbreviations from causing false splits (Mr., Dr.,
 * etc., U.S., e.g.).
 */
export function splitIntoSentences(text: string): string[] {
  if (!text) return []
  // Replace common abbreviation periods with a marker so the splitter
  // doesn't trip on them. Restore after splitting.
  const ABBREV = /\b(Mr|Mrs|Ms|Dr|St|Sr|Jr|vs|etc|e\.g|i\.e|U\.S|U\.K)\./gi
  const marked = text.replace(ABBREV, (m) => m.replace('.', '⌀'))
  const parts = marked
    .split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/)
    .map((s) => s.replace(/⌀/g, '.').trim())
    .filter(Boolean)
  return parts
}

export function framesFromSentences(text: string): BoordsFrame[] {
  return splitIntoSentences(text).map((sentence, i) => ({
    label: String(i + 1),
    sound: sentence,
    action: '',
  }))
}

// ─── A/V table detection (TSV + markdown table) ────────────────

/**
 * Detect a script formatted as an Audio/Visual table. Two flavors:
 *   1. Tab-separated rows (from Excel/Sheets) with headers including
 *      something matching /audio|voiceover|narration|sound/ and
 *      /visual|action|video/.
 *   2. Markdown pipe tables with the same column headers.
 *
 * Returns null if neither pattern matches.
 */
const AUDIO_RE = /(audio|voice\s*over|voiceover|narration|sound|vo)/i
const VISUAL_RE = /(visual|action|video|on[\s-]?screen|on[\s-]?cam)/i

export function detectAvTable(input: string): BoordsFrame[] | null {
  // Try markdown table first (| Audio | Visual | with --- separator).
  const md = tryMarkdownTable(input)
  if (md) return md
  // Fall back to TSV.
  const tsv = tryTsvTable(input)
  if (tsv) return tsv
  return null
}

function tryMarkdownTable(input: string): BoordsFrame[] | null {
  const lines = input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  // Find first row with at least two pipe-separated cells AND a separator row directly after.
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes('|')) continue
    if (!/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(lines[i + 1])) continue
    const headerCells = splitPipeRow(lines[i])
    const audioIdx = headerCells.findIndex((c) => AUDIO_RE.test(c))
    const visualIdx = headerCells.findIndex((c) => VISUAL_RE.test(c))
    if (audioIdx < 0 || visualIdx < 0) continue
    const out: BoordsFrame[] = []
    for (let j = i + 2; j < lines.length; j++) {
      if (!lines[j].includes('|')) break
      const cells = splitPipeRow(lines[j])
      const sound = (cells[audioIdx] || '').trim()
      const action = (cells[visualIdx] || '').trim()
      if (!sound && !action) continue
      out.push({ label: String(out.length + 1), sound, action })
    }
    if (out.length > 0) return out
  }
  return null
}

function splitPipeRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
}

function tryTsvTable(input: string): BoordsFrame[] | null {
  const lines = input.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return null
  // Each line should have at least one tab character.
  if (!lines.every((l) => l.includes('\t'))) return null
  const header = lines[0].split('\t').map((c) => c.trim())
  const audioIdx = header.findIndex((c) => AUDIO_RE.test(c))
  const visualIdx = header.findIndex((c) => VISUAL_RE.test(c))
  if (audioIdx < 0 || visualIdx < 0) return null
  const out: BoordsFrame[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t')
    const sound = (cells[audioIdx] || '').trim()
    const action = (cells[visualIdx] || '').trim()
    if (!sound && !action) continue
    out.push({ label: String(out.length + 1), sound, action })
  }
  return out.length > 0 ? out : null
}

// ─── AI extraction ─────────────────────────────────────────────

/**
 * Use Claude to extract VO + visuals from a free-form script. Useful
 * when the script is prose narrative without explicit visual cues.
 * The LLM is instructed to produce one frame per scene/beat with both
 * fields populated.
 *
 * Imports lazily so non-AI callers don't pull in the SDK.
 */
export async function framesFromAi(
  text: string,
  secondsPerFrame = 5,
): Promise<BoordsFrame[]> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const prompt = `You are a storyboard assistant. Split the following script into one frame per scene/beat. For each frame, produce JSON:
{
  "label": "1",
  "sound": "<verbatim voiceover or narration for this beat>",
  "action": "<concise visual description of what the viewer sees>"
}

Rules:
- Use the original voiceover text VERBATIM in "sound" — do not paraphrase.
- Write "action" as a brief, concrete visual description suitable for a storyboard panel.
- Aim for roughly ${secondsPerFrame}-second beats. Combine very short lines, split very long lines.
- Output ONLY a JSON array of frames, no preamble.

Script:
"""
${text.slice(0, 12000)}
"""`

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })
  const textBlock = (resp.content as any[]).find((b) => b.type === 'text')
  const raw = textBlock?.text || '[]'
  // Strip code fences if the model returned them despite instructions.
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  let parsed: any[]
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    // Fall back to sentence split if the model returned malformed JSON.
    return framesFromSentences(text)
  }
  return parsed.map((f: any, i: number) => ({
    label: String(f.label ?? i + 1),
    sound: String(f.sound ?? ''),
    action: String(f.action ?? ''),
  }))
}

// ─── Entry point ───────────────────────────────────────────────

/**
 * Parse a script into frames using the requested mode. 'auto' tries
 * table detection first, falls back to sentence split.
 */
export async function parseScript(
  input: string,
  mode: ExtractionMode = 'auto',
  secondsPerFrame = 5,
): Promise<ParsedScript> {
  if (mode === 'table') {
    const frames = detectAvTable(input)
    if (!frames || frames.length === 0) {
      throw new Error('No Audio/Visual table detected in the input.')
    }
    return { frames, modeUsed: 'table', detectedTable: true }
  }
  if (mode === 'sentence') {
    return {
      frames: framesFromSentences(input),
      modeUsed: 'sentence',
      detectedTable: false,
    }
  }
  if (mode === 'ai') {
    return {
      frames: await framesFromAi(input, secondsPerFrame),
      modeUsed: 'ai',
      detectedTable: false,
    }
  }
  // auto
  const av = detectAvTable(input)
  if (av && av.length > 0) {
    return { frames: av, modeUsed: 'table', detectedTable: true }
  }
  return {
    frames: framesFromSentences(input),
    modeUsed: 'sentence',
    detectedTable: false,
  }
}

// ─── Helpers shared with file parsers ─────────────────────────

/**
 * Pull a likely project name from a script filename.
 * Examples:
 *   "Tester - Script.docx"        → "Tester"
 *   "Acme_Spring_VO.txt"          → "Acme Spring VO"
 *   "Final_Storyboard_Script.docx" → "Final Storyboard Script"
 */
export function projectNameFromFilename(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]+$/i, '')
  // Strip common suffixes producers tack on.
  const stripped = base.replace(/\s*[-_]?\s*(script|storyboard|vo|narration|draft)\s*$/i, '')
  return stripped.replace(/[_]+/g, ' ').trim() || base
}
