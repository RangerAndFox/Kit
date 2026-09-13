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

/** Imgflip images are public-by-URL. Never put project/person details in these prompts. */
export const PUBLIC_MEME_BRIEFINGS = {
  birthday: 'A teammate is celebrating a birthday. Keep the person anonymous.',
  holiday: 'The studio team has a holiday off.',
  delivery_prepared: 'A creative team has prepared files for delivery. Celebrate the teamwork, not client approval or a confirmed shipment.',
} as const

/**
 * Imgflip's default fonts cannot reliably render emoji and arbitrary Unicode.
 * Normalize ordinary punctuation/accents; fall back to Slack text if anything
 * unsupported remains. Do not silently remove emoji that carry the punchline.
 */
export function normalizeImageCaption(text: string): string | null {
  // Reject common UTF-8-as-Latin-1 corruption before transliteration hides it.
  if (/[\uFFFD\u0080-\u009f]|ðŸ|Ã[\u00a0-\u00bf]|Â[\u00a0-\u00bf]|â[€™œž]/u.test(text)) return null
  const plain = text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/…/g, '...')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ').trim()
  if (/[^\x20-\x7e]/.test(plain) || plain.length > 180) return null
  return plain
}

export function isMemeImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'i.imgflip.com'
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && /^\/[a-z0-9]+\.(?:jpg|png|gif)$/i.test(url.pathname)
  } catch { return false }
}

/**
 * Render the meme via Imgflip. Returns the image URL, or null when Imgflip
 * isn't configured or the call fails (caller falls back to a text meme).
 */
export async function renderMemeImage(template: MemeTemplate, boxes: string[]): Promise<string | null> {
  const username = process.env.IMGFLIP_USERNAME
  const password = process.env.IMGFLIP_PASSWORD
  if (!username || !password) return null
  const safeBoxes = boxes.map(normalizeImageCaption)
  if (boxes.length !== template.boxes || safeBoxes.some(text => text === null) || !safeBoxes.some(Boolean)) return null

  const params = new URLSearchParams()
  params.set('template_id', template.id)
  params.set('username', username)
  params.set('password', password)
  safeBoxes.forEach((text, i) => params.set(`boxes[${i}][text]`, text!))

  try {
    const res = await fetch('https://api.imgflip.com/caption_image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data?.success && isMemeImageUrl(data?.data?.url)) return data.data.url
    console.warn('[meme-engine] imgflip did not return a valid image')
    return null
  } catch {
    console.warn('[meme-engine] imgflip request failed')
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
- Use plain English text with ASCII punctuation. No emoji, emoticons, Slack codes, or decorative symbols.
- Do not invent client replies, approvals, budgets, or names.
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
 * Custom briefings stay in Slack as text. Images use only allowlisted generic
 * occasions so client names, contacts, budgets and project details never enter
 * the public renderer's caption-generation context.
 */
export async function postMeme(
  app: App,
  opts: { channel: string; headline: string; briefing: string; altText?: string; templateIndex?: number; publicOccasion?: keyof typeof PUBLIC_MEME_BRIEFINGS },
): Promise<{ posted: boolean; template: string; image: boolean; reason?: string }> {
  const { channel, headline, briefing } = opts
  if (!channel) return { posted: false, template: '', image: false, reason: 'no channel' }

  const template = pickTemplate(CELEBRATION_TEMPLATES, opts.templateIndex)
  const publicBriefing = opts.publicOccasion && Object.hasOwn(PUBLIC_MEME_BRIEFINGS, opts.publicOccasion)
    ? PUBLIC_MEME_BRIEFINGS[opts.publicOccasion] : null
  const boxes = await generateCaption(template, publicBriefing || briefing).catch(() => [])
  const imageUrl = publicBriefing && boxes.some(Boolean) ? await renderMemeImage(template, boxes) : null

  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: headline } }]
  if (imageUrl) {
    blocks.push({ type: 'image', image_url: imageUrl, alt_text: `${opts.altText || template.name}: ${boxes.join(' / ')}`.slice(0, 2000) })
  } else if (boxes.some(Boolean)) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: textMeme(template, boxes) } })
  }

  await app.client.chat.postMessage({ channel, text: headline.replace(/[<>*_:]/g, ''), blocks })
  return { posted: true, template: template.name, image: Boolean(imageUrl) }
}
