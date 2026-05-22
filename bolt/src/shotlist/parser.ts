// @ts-nocheck
/**
 * Shot list parser — Claude Haiku.
 *
 * Two modes:
 *   - parseScript: free-form script → Shot[]
 *   - parseMutation: free-form edit instruction → ShotMutation
 */

import Anthropic from '@anthropic-ai/sdk'
import type { Shot, ShotMutation } from './types'

const SYSTEM_PARSE = `You break video/film scripts into structured shot lists.
Given a script or prose description, output a JSON array of shots. Each shot:
{ "number": <int 1..N>, "action": "<what happens visually>", "dialogue": "<spoken text or empty>", "duration": "<estimate like '2s' or 'TBD'>", "notes": "<camera/lens hints or empty>" }

Rules:
- Match the shot count to natural beats in the script. Aim for 3-15 shots.
- Action is REQUIRED. Dialogue/duration/notes are optional (use empty string if unknown).
- Output JSON only — no prose, no markdown fences.`

const SYSTEM_MUTATE = `You parse natural-language edit instructions into structured operations on a shot list.
Operations:
  - insert: { "op": "insert", "after_shot_number": <int>, "shot": {...} }
  - update: { "op": "update", "shot_number": <int>, "shot": {...} }
  - delete: { "op": "delete", "shot_number": <int> }
  - replace_all: { "op": "replace_all", "shots": [...] }

Output JSON only.`

function stripFences(text: string): string {
  return text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()
}

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  return new Anthropic({ apiKey })
}

export async function parseScript(script: string): Promise<Shot[]> {
  const client = getClient()
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: SYSTEM_PARSE,
    messages: [{ role: 'user', content: `Script:\n\n${script}\n\nReturn the JSON array.` }],
  })
  const text = res.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
  const cleaned = stripFences(text)
  const parsed = JSON.parse(cleaned)
  if (!Array.isArray(parsed)) throw new Error('Parser did not return a JSON array')
  // Normalize: 1-index and require action.
  return parsed
    .map((s: any, i: number) => ({
      number: typeof s.number === 'number' ? s.number : i + 1,
      action: String(s.action || '').trim(),
      dialogue: s.dialogue ? String(s.dialogue) : undefined,
      duration: s.duration ? String(s.duration) : undefined,
      notes: s.notes ? String(s.notes) : undefined,
    }))
    .filter((s: Shot) => s.action.length > 0)
    .map((s: Shot, i: number) => ({ ...s, number: i + 1 }))
}

export async function parseMutation(
  instruction: string,
  existingShots: Shot[],
): Promise<ShotMutation> {
  const client = getClient()
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_MUTATE,
    messages: [
      {
        role: 'user',
        content: `Current shot list (${existingShots.length} shots):\n${JSON.stringify(existingShots, null, 2)}\n\nEdit instruction:\n${instruction}\n\nReturn the JSON operation.`,
      },
    ],
  })
  const text = res.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
  return JSON.parse(stripFences(text))
}
