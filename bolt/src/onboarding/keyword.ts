// @ts-nocheck
/**
 * Natural-language onboarding trigger.
 *
 * Kit recognizes phrases like:
 *   "@Kit onboard alice@studio.com to Rayfin"
 *   "onboard alice smith (alice@studio.com) to project 2622"
 *   "can you onboard a new freelancer? alice@studio.com, Rayfin"
 *
 * Flow:
 *   1. Cheap regex pre-filter: message contains the word "onboard"
 *   2. Permission check (PM / CD / admin)
 *   3. Haiku parse → { artistName, artistEmail, projectQuery, missingFields }
 *   4. Resolve projectQuery against public.projects (name / client / project_code)
 *   5. If all present → post confirmation card with an [Onboard] button
 *   6. If anything missing → Kit replies asking only for what's missing
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { anthropic, SPECIALIST_MODEL } from '../llm/client'
import { canOnboard } from './permissions'

/** Cheap detector — does this message even mention onboarding? */
export function isOnboardTrigger(text: string): boolean {
  return /\bonboard(?:ing|ed|s)?\b/i.test(text)
}

interface ExtractedIntent {
  artistName: string | null
  artistEmail: string | null
  projectQuery: string | null
  isOnboardingIntent: boolean
}

/**
 * Parse a free-form message into onboarding fields. Returns
 * `isOnboardingIntent=false` if the LLM decides the message isn't
 * actually an onboarding request (false positive on the keyword).
 */
async function parseOnboardIntent(text: string): Promise<ExtractedIntent> {
  const systemPrompt = `Decide if a message is about freelancer onboarding,
and pull out any details the user gave.

Return strict JSON:
{
  "isOnboardingIntent": boolean,
  "artistName": string | null,
  "artistEmail": string | null,
  "projectQuery": string | null
}

Decide isOnboardingIntent like this:
- true if the user wants to add a person (freelancer/artist/contractor)
  to a project / Slack / Frame.io / Dropbox / Harvest.
- true even when no details are given. A bare "onboard" or "onboard a
  freelancer" should still be true — we'll ask follow-up questions.
- false ONLY when the context is clearly something else:
    "let's onboard a new project" → false (different flow)
    "onboard a new client"        → false
    "what's the onboarding doc"   → false
    "the onboarding process"      → false

Extract any details that are present (otherwise null):
- artistEmail: must contain "@". Pull from anywhere in the message.
- artistName: the person's name if given. "alice smith (alice@…)"
  → "alice smith". A bare email like "alice@studio.com" → null.
- projectQuery: code, client, or name. "to Rayfin" → "Rayfin";
  "project 2622" → "2622"; "the Microsoft thing" → "Microsoft".

Return ONLY the JSON object — no prose, no code fences.`

  const res = await anthropic.messages.create({
    model: SPECIALIST_MODEL,
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: text }],
  })
  const out =
    res.content
      ?.filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('') || ''
  const cleaned = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    return {
      isOnboardingIntent: !!parsed.isOnboardingIntent,
      artistName: parsed.artistName || null,
      artistEmail: parsed.artistEmail || null,
      projectQuery: parsed.projectQuery || null,
    }
  } catch {
    return {
      isOnboardingIntent: false,
      artistName: null,
      artistEmail: null,
      projectQuery: null,
    }
  }
}

interface ProjectMatch {
  id: string
  name: string
  client: string | null
  project_code: string | null
}

/**
 * Resolve a project query string to a single project row.
 * Returns null if no match, the single match, or 'ambiguous' with up to 5.
 */
async function resolveProject(query: string): Promise<
  | { kind: 'matched'; project: ProjectMatch }
  | { kind: 'ambiguous'; candidates: ProjectMatch[] }
  | { kind: 'unmatched' }
> {
  const sb = createAdminClient()
  const q = query.trim()
  // Match name OR client OR project_code (case-insensitive contains).
  const { data } = await sb
    .from('projects')
    .select('id, name, client, project_code')
    .or(
      `name.ilike.%${q}%,client.ilike.%${q}%,project_code.ilike.%${q}%`,
    )
    .limit(5)
  const list = (data || []) as ProjectMatch[]
  if (list.length === 0) return { kind: 'unmatched' }
  if (list.length === 1) return { kind: 'matched', project: list[0] }
  // Prefer exact code match
  const exact = list.find(
    (p) => (p.project_code || '').toLowerCase() === q.toLowerCase(),
  )
  if (exact) return { kind: 'matched', project: exact }
  return { kind: 'ambiguous', candidates: list }
}

/**
 * Render the confirmation card.
 */
function buildConfirmCard(opts: {
  artistName: string
  artistEmail: string
  project: ProjectMatch
}) {
  const { artistName, artistEmail, project } = opts
  const value = JSON.stringify({
    p: project.id,
    n: artistName,
    e: artistEmail,
  })
  return {
    text: `Onboard ${artistName} to ${project.name}?`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*Onboard a freelancer*\n\n` +
            `• *Artist:* ${artistName}\n` +
            `• *Email:* ${artistEmail}\n` +
            `• *Project:* ${[project.project_code, project.client, project.name].filter(Boolean).join(' · ')}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: ':white_check_mark: Onboard' },
            style: 'primary',
            action_id: 'kit_onboard_confirm',
            value,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Cancel' },
            action_id: 'kit_onboard_cancel',
          },
        ],
      },
    ],
  }
}

/**
 * Top-level entry for natural-language onboarding.
 *
 * @returns true if handled (caller should NOT route to orchestrator).
 */
export async function handleOnboardKeyword(opts: {
  app: App
  channelId: string
  threadTs?: string
  userId: string
  text: string
}): Promise<boolean> {
  const { app, channelId, threadTs, userId, text } = opts

  // Permission gate
  const allowed = await canOnboard(userId)
  if (!allowed) {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text:
        ":lock: Onboarding's restricted to PMs, CDs, and admins. If that's you, your `staff.role` isn't set yet — ping an admin.",
    })
    return true
  }

  // Parse intent
  const intent = await parseOnboardIntent(text)
  if (!intent.isOnboardingIntent) {
    // False positive — let the orchestrator handle it.
    return false
  }

  // Ask for missing pieces if any
  const missing: string[] = []
  if (!intent.artistEmail) missing.push('artist email')
  if (!intent.projectQuery) missing.push('project (name, code, or client)')
  if (missing.length > 0) {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text:
        `Happy to onboard them — can you tell me the ${missing.join(' and ')}? E.g. _"onboard Alice Smith alice@studio.com to Rayfin"_.`,
    })
    return true
  }

  // Resolve project
  const r = await resolveProject(intent.projectQuery!)
  if (r.kind === 'unmatched') {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text:
        `I couldn't find a project matching _"${intent.projectQuery}"_. Try the project code (e.g. \`2622\`), client name, or project name.`,
    })
    return true
  }
  if (r.kind === 'ambiguous') {
    const opts = r.candidates
      .map(
        (c, i) =>
          `${i + 1}. *${c.name}*${c.project_code ? ` (${c.project_code})` : ''}${c.client ? ` — ${c.client}` : ''}`,
      )
      .join('\n')
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text:
        `Multiple projects matched _"${intent.projectQuery}"_:\n${opts}\n\nReply with the project code to disambiguate.`,
    })
    return true
  }

  // We have everything — post the confirmation card.
  const artistName = intent.artistName || intent.artistEmail!.split('@')[0]
  await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    ...buildConfirmCard({
      artistName,
      artistEmail: intent.artistEmail!,
      project: r.project,
    }),
  })
  return true
}
