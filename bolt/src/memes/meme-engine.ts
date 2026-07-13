// @ts-nocheck
/**
 * Shared meme engine.
 *
 * The imgflip rendering + text-fallback primitives (originally inline in
 * timesheet-meme.ts) plus a generic, occasion-driven caption + post path used
 * by the celebration memes (birthdays, deliveries, holidays, ad-hoc, etc.).
 *
 * Config:
 *   IMGFLIP_USERNAME / IMGFLIP_PASSWORD — optional; enables rendered images.
 *   (Without them everything degrades to a formatted text meme.)
 */

import type { App } from '@slack/bolt'
import { anthropic, ORCHESTRATOR_MODEL } from '../llm/client'

export interface MemeTemplate {
  id: string // Imgflip template id
  name: string
  boxes: number
  /** What each text box represents, structurally (occasion-agnostic). */
  layout: string
}

/** Celebration-friendly templates with occasion-neutral layout hints. */
export const CELEBRATION_TEMPLATES: MemeTemplate[] = [
  { id: '181913649', name: 'Drake Hotline Bling', boxes: 2, layout: 'box0 = a lesser / mundane alternative (rejected); box1 = the thing being celebrated (approved)' },
  { id: '61544', name: 'Success Kid', boxes: 2, layout: 'box0 = short setup of the situation; box1 = the triumphant win' },
  { id: '124055727', name: 'Leonardo DiCaprio Cheers', boxes: 1, layout: 'box0 = a short celebratory toast to the occasion' },
  { id: '129242436', name: 'Change My Mind', boxes: 1, layout: 'box0 = a bold, upbeat statement written on the sign' },
  { id: '155067746', name: 'Surprised Pikachu', boxes: 1, layout: 'box0 = a playful mock-surprised reaction to the good news' },
  { id: '61579', name: 'One Does Not Simply', boxes: 2, layout: 'box0 = "One does not simply"; box1 = the celebratory punchline' },
  { id: '93895088', name: 'Expanding Brain', boxes: 4, layout: 'escalating levels of celebration, box0 (mild) → box3 (euphoric)' },
]

/** Normalize the model's boxes to exactly the template's box count. Pure. */
export function normalizeBoxes(raw: unknown, count: number): string[] {
  const arr = Array.isArray(raw) ? raw.map((s) => String(s ?? '').trim()) : []
  const out = arr.slice(0, count)
  while (out.length < count) out.push('')
  return out
}

/** Pick a template — random by default; pass `index` for determinism / tests. Pure given index. */
export function pickTemplate(templates: MemeTemplate[] = CELEBRATION_TEMPLATES, index?: number): MemeTemplate {
  const n = templates.length
  const i = typeof index === 'number' ? index : Math.floor(Math.random() * n)
  return templates[((i % n) + n) % n]
}

/**
 * Render the meme via Imgflip. Returns the image URL, or null when Imgflip
 * isn't configured or the call fails (caller falls back to a text meme).
 */
export async function renderMemeImage(template: MemeTemplate, boxes: string[]): Promise<string | null> {
  const username = process.env.IMGFLIP_USERNAME
  const password = process.env.IMGFLIP_PASSWORD
  if (!username || !password) return null

  const params = new URLSearchParams()
  params.set('template_id', template.id)
  params.set('username', username)
  params.set('password', password)
  boxes.forEach((text, i) => params.set(`boxes[${i}][text]`, text))

  try {
    const res = await fetch('https://api.imgflip.com/caption_image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json()
    if (data?.success && data?.data?.url) return data.data.url as string
    console.warn(`[meme-engine] imgflip: ${data?.error_message || 'no url returned'}`)
    return null
  } catch (err: any) {
    console.warn(`[meme-engine] imgflip request failed: ${err?.message || err}`)
    return null
  }
}

/** Text-meme fallback when there's no rendered image. Pure. */
export function textMeme(template: MemeTemplate, boxes: string[]): string {
  const body = boxes.filter(Boolean).map((b) => `> ${b}`).join('\n')
  return `_${template.name}_\n${body}`
}

/** Ask the model for a celebratory caption for `briefing` on this template. */
export async function generateCaption(template: MemeTemplate, briefing: string): Promise<string[]> {
  const system = `You write funny, warm, workplace-appropriate celebration memes for a creative video studio (Ranger & Fox).

Write the caption for the "${template.name}" meme template.
Boxes: ${template.layout}
Occasion: ${briefing}

Rules:
- Celebratory and kind — never mean or sarcastic at anyone's expense. No profanity.
- Don't invent facts beyond the occasion described.
- Keep each box punchy (a handful of words).
- Return STRICT JSON, no prose, no code fences: { "boxes": [ ... ] } with EXACTLY ${template.boxes} string(s), in order.`

  const res = await anthropic.messages.create({
    model: ORCHESTRATOR_MODEL,
    max_tokens: 400,
    system,
    messages: [{ role: 'user', content: `Write the meme for: ${briefing}` }],
  })
  const raw =
    res.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('') || ''
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  let parsed: any = {}
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    /* fall through — empty boxes, caller handles */
  }
  return normalizeBoxes(parsed?.boxes, template.boxes)
}

/**
 * Compose + post a celebration meme to a channel. `headline` is the mrkdwn
 * line above the image; `briefing` drives the caption. Falls back to a text
 * meme without imgflip, and to the headline alone if the model returns nothing.
 */
export async function postMeme(
  app: App,
  opts: { channel: string; headline: string; briefing: string; altText?: string; templateIndex?: number },
): Promise<{ posted: boolean; template: string; image: boolean; reason?: string }> {
  const { channel, headline, briefing } = opts
  if (!channel) return { posted: false, template: '', image: false, reason: 'no channel' }

  const template = pickTemplate(CELEBRATION_TEMPLATES, opts.templateIndex)
  const boxes = await generateCaption(template, briefing).catch(() => [])
  const imageUrl = boxes.some(Boolean) ? await renderMemeImage(template, boxes) : null

  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: headline } }]
  if (imageUrl) {
    blocks.push({ type: 'image', image_url: imageUrl, alt_text: opts.altText || `${template.name} meme` })
  } else if (boxes.some(Boolean)) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: textMeme(template, boxes) } })
  }

  await app.client.chat.postMessage({ channel, text: headline.replace(/[<>*_:]/g, ''), blocks })
  return { posted: true, template: template.name, image: Boolean(imageUrl) }
}
