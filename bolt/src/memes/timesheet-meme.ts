// @ts-nocheck
/**
 * Weekly timesheet meme.
 *
 * Once a week Kit posts a meme about filling out timesheets in the full-team
 * channel with an @channel mention. It rotates through popular meme templates
 * (a different one each week), has the model write the timesheet-themed
 * caption, and renders a real image via the Imgflip caption API. Without
 * Imgflip credentials it degrades to a nicely-formatted text meme so the
 * nudge still lands.
 *
 * Config:
 *   KIT_TEAM_CHANNEL_ID              — required; the full-team channel
 *   IMGFLIP_USERNAME / IMGFLIP_PASSWORD — optional; enables rendered images
 */

import type { App } from '@slack/bolt'
import { anthropic, ORCHESTRATOR_MODEL } from '../llm/client'

export interface MemeTemplate {
  id: string // Imgflip template id
  name: string
  boxes: number
  /** What each text box represents + the timesheet angle, for the caption model. */
  layout: string
}

/** Rotation of well-known meme formats. A different one fires each week. */
export const TEMPLATES: MemeTemplate[] = [
  { id: '181913649', name: 'Drake Hotline Bling', boxes: 2, layout: 'box0 = the timesheet habit Drake rejects (bad); box1 = the habit Drake approves (good)' },
  { id: '87743020', name: 'Two Buttons', boxes: 3, layout: 'box0 = first button, box1 = second button (two conflicting timesheet temptations); box2 = the sweating person, e.g. "Me at 4:59pm Friday"' },
  { id: '129242436', name: 'Change My Mind', boxes: 1, layout: 'box0 = a bold timesheet hot-take written on the sign' },
  { id: '4087833', name: 'Waiting Skeleton', boxes: 2, layout: 'box0 = short setup; box1 = "Me waiting for everyone to log their hours"' },
  { id: '61579', name: 'One Does Not Simply', boxes: 2, layout: 'box0 = "One does not simply"; box1 = the hard timesheet truth' },
  { id: '438680', name: 'Batman Slapping Robin', boxes: 2, layout: "box0 = Robin's bad timesheet excuse; box1 = Batman's slap-correction" },
  { id: '131940431', name: "Gru's Plan", boxes: 4, layout: 'a 4-panel plan to avoid timesheets where the last panel is it backfiring; box0..box3 escalate' },
  { id: '93895088', name: 'Expanding Brain', boxes: 4, layout: 'escalating galaxy-brain levels of timesheet enlightenment, box0 (basic) → box3 (transcendent)' },
  { id: '102156234', name: 'Mocking Spongebob', boxes: 1, layout: 'box0 = a timesheet excuse rendered in mocking AlTeRnAtInG case' },
  { id: '55311130', name: 'This Is Fine', boxes: 1, layout: 'box0 = caption about ignoring the overdue timesheet while everything burns' },
  { id: '217743513', name: 'UNO Draw 25', boxes: 2, layout: 'box0 = "Fill out your timesheet or draw 25"; box1 = short reaction implying they would rather draw 25' },
  { id: '124822590', name: 'Left Exit 12 Off Ramp', boxes: 3, layout: 'box0 = the straight road (doing your timesheet on time); box1 = the off-ramp (procrastinating); box2 = the swerving car = "Me"' },
]

/** Deterministic week index → template. Pure. */
export function pickWeeklyTemplate(weekIndex: number, templates: MemeTemplate[] = TEMPLATES): MemeTemplate {
  const n = templates.length
  return templates[((weekIndex % n) + n) % n]
}

/** Weeks since the Unix epoch — a stable, incrementing weekly counter. */
export function weekIndexFromMs(ms: number): number {
  return Math.floor(ms / (7 * 24 * 60 * 60 * 1000))
}

/** Normalize the model's boxes to exactly the template's box count. Pure. */
export function normalizeBoxes(raw: unknown, count: number): string[] {
  const arr = Array.isArray(raw) ? raw.map((s) => String(s ?? '').trim()) : []
  const out = arr.slice(0, count)
  while (out.length < count) out.push('')
  return out
}

/** Ask the model for the week's timesheet caption for this template. */
export async function generateCaption(template: MemeTemplate): Promise<string[]> {
  const system = `You write funny, workplace-appropriate memes for a creative video studio (Ranger & Fox) whose people keep forgetting to log their time in Harvest.

Write the caption for the "${template.name}" meme template.
Boxes: ${template.layout}

Rules:
- The joke is about filling out / forgetting timesheets.
- Keep each box punchy (a handful of words). No profanity, no calling out individuals.
- Return STRICT JSON, no prose, no code fences: { "boxes": [ ... ] } with EXACTLY ${template.boxes} string(s), in order.`

  const res = await anthropic.messages.create({
    model: ORCHESTRATOR_MODEL,
    max_tokens: 400,
    system,
    messages: [{ role: 'user', content: `Write this week's ${template.name} timesheet meme.` }],
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
    /* fall through to normalizeBoxes → empty boxes → caller handles */
  }
  return normalizeBoxes(parsed?.boxes, template.boxes)
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
    console.warn(`[timesheet-meme] imgflip: ${data?.error_message || 'no url returned'}`)
    return null
  } catch (err: any) {
    console.warn(`[timesheet-meme] imgflip request failed: ${err?.message || err}`)
    return null
  }
}

/** Text-meme fallback when there's no rendered image. */
function textMeme(template: MemeTemplate, boxes: string[]): string {
  const body = boxes.filter(Boolean).map((b) => `> ${b}`).join('\n')
  return `_${template.name}_\n${body}`
}

/**
 * Compose + post the weekly timesheet meme to the full-team channel with an
 * @channel mention. `weekIndex` defaults to the current week; pass it for
 * tests / manual runs. Returns what happened.
 */
export async function postWeeklyTimesheetMeme(
  app: App,
  weekIndex: number,
): Promise<{ posted: boolean; template: string; image: boolean; reason?: string }> {
  const channel = process.env.KIT_TEAM_CHANNEL_ID
  if (!channel) return { posted: false, template: '', image: false, reason: 'KIT_TEAM_CHANNEL_ID not set' }

  const template = pickWeeklyTemplate(weekIndex)
  const boxes = await generateCaption(template)
  if (!boxes.some(Boolean)) {
    return { posted: false, template: template.name, image: false, reason: 'caption generation returned empty' }
  }

  const imageUrl = await renderMemeImage(template, boxes)

  const header = `<!channel> :calendar: *Timesheet meme of the week*`
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: header } }]
  if (imageUrl) {
    blocks.push({ type: 'image', image_url: imageUrl, alt_text: `${template.name} timesheet meme` })
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${template.name}_ · log your hours in Harvest :saluting_face:` }],
    })
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: textMeme(template, boxes) } })
  }

  await app.client.chat.postMessage({
    channel,
    text: 'Timesheet meme of the week — log your hours!',
    blocks,
  })
  return { posted: true, template: template.name, image: Boolean(imageUrl) }
}
