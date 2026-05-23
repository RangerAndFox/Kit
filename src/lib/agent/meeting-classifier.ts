// @ts-nocheck
/**
 * Meeting → Project classifier.
 *
 * Given a calendar event and the workspace's active projects, calls
 * Claude Haiku to pick the best matching project (or null). Returns
 * confidence 0..1.
 *
 * Pattern: mirrors src/lib/agent/call-classifier.ts.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { CalendarEvent } from '@/lib/integrations/google-calendar'

export interface ActiveProject {
  id: string
  name: string
  client: string | null
  project_code: string | null
  brief_summary: string | null
  team_emails: string[]
}

export interface ClassificationResult {
  project_id: string | null
  confidence: number
  reasoning: string
}

const SYSTEM_PROMPT = `You are a meeting-to-project classifier for a video studio.
Given a calendar event and a list of active projects, identify which project the
meeting is most likely about. Match on (in priority order):

1. Project code or client name appearing in the meeting title.
2. Attendees whose emails match a project's team_emails.
3. Keywords in the meeting title matching the project's brief_summary.

Return JSON only:
{
  "project_id": "<uuid or null>",
  "confidence": <0.0..1.0>,
  "reasoning": "<one short sentence>"
}

If no project clearly matches, return project_id: null with low confidence.
Never guess; prefer null over a low-confidence match.`

export async function classifyMeeting(
  event: CalendarEvent,
  activeProjects: ActiveProject[],
): Promise<ClassificationResult> {
  if (activeProjects.length === 0) {
    return { project_id: null, confidence: 0, reasoning: 'no active projects' }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set')
  }

  const client = new Anthropic({ apiKey })

  const userPrompt = `Calendar event:
  title: ${JSON.stringify(event.summary)}
  description: ${JSON.stringify(event.description || '')}
  attendees: ${JSON.stringify(event.attendees.map((a) => a.email))}
  organizer: ${JSON.stringify(event.organizer?.email || '')}

Active projects:
${JSON.stringify(activeProjects, null, 2)}

Respond with JSON only.`

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const text = res.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')

  // Strip code fences if Haiku wrapped the JSON.
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()

  let parsed: ClassificationResult
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    throw new Error(`Classifier returned non-JSON: ${cleaned}`)
  }

  if (typeof parsed.confidence !== 'number') parsed.confidence = 0
  if (!parsed.project_id) parsed.project_id = null
  if (!parsed.reasoning) parsed.reasoning = ''
  return parsed
}
