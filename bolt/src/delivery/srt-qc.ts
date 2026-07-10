// @ts-nocheck
/**
 * SRT proofreading QC.
 *
 * Kit already watches the accessibility folder and converts SRTs to caption
 * siblings. This adds a proofreading pass: the caption text is checked for
 * spelling, grammar, capitalization, punctuation, and brand/product naming
 * errors, and a report is posted in the project channel — green check if
 * clean, red X with the specific mistakes if not.
 *
 * Deliberately conservative: it flags genuine errors, not stylistic taste,
 * and ignores timing, formatting, speaker labels, and [sound] tags.
 */

import { anthropic, SPECIALIST_MODEL } from '../llm/client'
import { parseSrt } from '../../../src/lib/delivery/subtitle-convert'

export interface QcIssue {
  cue: number
  category: 'spelling' | 'grammar' | 'capitalization' | 'punctuation' | 'naming'
  text: string
  problem: string
  fix: string
}

export interface QcReport {
  checked: boolean // false when the proofread couldn't run (parse/LLM error)
  clean: boolean
  cueCount: number
  issues: QcIssue[]
}

const MAX_CUES = 600 // a normal spot/short; guards the prompt size

/**
 * Proofread the captions in an SRT. Returns a structured report. Never
 * throws — a failure returns { checked: false } so the caller can stay quiet
 * rather than post a broken report.
 */
export async function proofreadSrt(srtText: string): Promise<QcReport> {
  let cues
  try {
    cues = parseSrt(srtText)
  } catch {
    return { checked: false, clean: true, cueCount: 0, issues: [] }
  }
  if (!cues.length) return { checked: false, clean: true, cueCount: 0, issues: [] }

  // Number each cue so the model (and the report) can reference it.
  const numbered = cues
    .slice(0, MAX_CUES)
    .map((c, i) => `${i + 1}: ${c.lines.join(' ')}`)
    .join('\n')

  const system = `You are a meticulous caption proofreader for a professional video studio.

You are given subtitle cues, one per line, prefixed with their cue number.
Find genuine errors ONLY in these categories:
- spelling: misspelled words
- grammar: clear grammatical mistakes
- capitalization: wrong case (sentence starts, proper nouns)
- punctuation: missing/incorrect punctuation that changes correctness
- naming: misspelled or mis-cased brand/product names. This studio does work
  for Microsoft, Azure, Copilot, GitHub, Crunchyroll, etc. Flag things like
  "Github"→"GitHub", "Powerpoint"→"PowerPoint", "co-pilot"→"Copilot",
  "azure"→"Azure" (when it's the brand), "crunchy roll"→"Crunchyroll".

Do NOT flag: timing, line breaks, formatting, ALL-CAPS speaker labels,
[music]/[applause]/(laughs) sound tags, or stylistic/subjective choices.
Be conservative — if it's not clearly wrong, don't report it.

Return STRICT JSON, no prose, no code fences:
{ "issues": [ { "cue": <number>, "category": "<one of the five>", "text": "<the exact wrong phrase>", "problem": "<short reason>", "fix": "<corrected phrase>" } ] }
If there are no errors, return { "issues": [] }.`

  let raw = ''
  try {
    const res = await anthropic.messages.create({
      model: SPECIALIST_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: numbered }],
    })
    raw =
      res.content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('') || ''
  } catch {
    return { checked: false, clean: true, cueCount: cues.length, issues: [] }
  }

  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  let parsed
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return { checked: false, clean: true, cueCount: cues.length, issues: [] }
  }

  const valid = new Set(['spelling', 'grammar', 'capitalization', 'punctuation', 'naming'])
  const issues: QcIssue[] = (Array.isArray(parsed?.issues) ? parsed.issues : [])
    .filter((i) => i && valid.has(i.category) && i.text)
    .map((i) => ({
      cue: Number(i.cue) || 0,
      category: i.category,
      text: String(i.text),
      problem: String(i.problem || ''),
      fix: String(i.fix || ''),
    }))

  return { checked: true, clean: issues.length === 0, cueCount: cues.length, issues }
}

const CATEGORY_LABEL: Record<QcIssue['category'], string> = {
  spelling: 'spelling',
  grammar: 'grammar',
  capitalization: 'capitalization',
  punctuation: 'punctuation',
  naming: 'naming',
}

/** Slack blocks for the QC report. Returns null when QC didn't run. */
export function buildQcBlocks(report: QcReport, srtName: string) {
  if (!report.checked) return null

  if (report.clean) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:white_check_mark: *Caption QC passed* — \`${srtName}\` (${report.cueCount} cues)\nNo spelling, grammar, capitalization, or naming issues found.`,
        },
      },
    ]
  }

  const lines = report.issues
    .slice(0, 25)
    .map((i) => {
      const arrow = i.fix ? ` → *${i.fix}*` : ''
      const why = i.problem ? ` — ${i.problem}` : ''
      return `• *Cue ${i.cue}* [${CATEGORY_LABEL[i.category]}]: “${i.text}”${arrow}${why}`
    })
  const more = report.issues.length > 25 ? `\n…and ${report.issues.length - 25} more` : ''

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:x: *Caption QC — ${report.issues.length} issue${report.issues.length === 1 ? '' : 's'}* in \`${srtName}\` (${report.cueCount} cues)`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') + more },
    },
  ]
}
