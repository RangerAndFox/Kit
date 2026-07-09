// @ts-nocheck
/**
 * Channel participation — Kit as an active team member.
 *
 * Watches project-channel conversation (no @mention needed) and, when — and
 * ONLY when — it can add clear value, replies in-thread:
 *   - answer:  the question is answerable from the knowledge base
 *              (channel brain + project docs), cited to its source
 *   - asset:   someone asked for a link/file the project record has
 *              (Frame.io project, Dropbox folder)
 *   - ping:    a human question with an obvious owner — Kit routes it
 *
 * PRECISION OVER RECALL. The fastest way to make the team mute Kit is a
 * wrong or needless reply, so every layer is biased to silence:
 *   1. Cheap prefilter (no AI): only question/asset-request-shaped messages
 *      proceed; anything @mentioning a person is theirs to answer; short
 *      reactions and link pastes are skipped.
 *   2. Retrieval-first: the model sees ONLY fetched context and must answer
 *      from it or stay quiet — no general knowledge.
 *   3. High confidence bars (answer/asset 0.8, ping 0.9), one unprompted
 *      reply per thread, a per-channel cooldown, and a financial-content
 *      output guard (channel replies are visible to everyone in it).
 *
 * Scope: channels with a brain OR a linked project. Kill switch:
 * KIT_CHANNEL_PARTICIPATION_ENABLED=false.
 */

import type { App } from '@slack/bolt'
import { anthropic, SPECIALIST_MODEL } from '../llm/client'
import { gatherParticipationContext } from './context'

// ─── Tunables ───────────────────────────────────────────────

/** Min gap between unprompted replies in the same channel. */
const CHANNEL_COOLDOWN_MS = 10 * 60 * 1000
/** Confidence floors per action. */
const MIN_CONF = { answer: 0.8, asset: 0.8, ping: 0.9 }

export function participationEnabled(): boolean {
  return process.env.KIT_CHANNEL_PARTICIPATION_ENABLED !== 'false'
}

// ─── Prefilter (pure, no AI) ────────────────────────────────

const ASSET_REQUEST_RE =
  /\b(where('?s| is| are)?|link (to|for)|send (me|us|over)|share (the|a)|latest (cut|version|link)|frame\.?io link|dropbox (link|folder)|can (someone|anyone|you) (send|share|post|drop))\b/i

const NOISE_RE = /^(\+1|👍|ok|okay|cool|nice|thanks|thank you|lol|ha+|yes|no|yep|nope|sounds good)\W*$/i

/**
 * Should this message even be considered? Pure — unit-tested.
 * Yes only for question-shaped or asset-request-shaped messages that aren't
 * addressed to a specific person and aren't trivial chatter.
 */
export function looksAddressable(text: string): boolean {
  const t = (text || '').trim()
  if (t.length < 8 || t.length > 600) return false
  if (NOISE_RE.test(t)) return false
  // Addressed to a specific person → theirs to answer, not Kit's.
  if (/<@[UW][A-Z0-9]+/.test(t)) return false
  // A bare link paste isn't a question.
  const withoutLinks = t.replace(/<https?:\/\/[^>]+>|https?:\/\/\S+/gi, '').trim()
  if (withoutLinks.length < 8) return false
  return withoutLinks.includes('?') || ASSET_REQUEST_RE.test(withoutLinks)
}

// ─── Rate limiting (in-memory; single replica) ──────────────

const lastReplyByChannel = new Map<string, number>()
const answeredThreads = new Set<string>()

export function underCooldown(channelId: string, now = Date.now()): boolean {
  const last = lastReplyByChannel.get(channelId) || 0
  return now - last < CHANNEL_COOLDOWN_MS
}

export function threadAlreadyAnswered(channelId: string, threadTs: string): boolean {
  return answeredThreads.has(`${channelId}:${threadTs}`)
}

function recordReply(channelId: string, threadTs: string): void {
  lastReplyByChannel.set(channelId, Date.now())
  answeredThreads.add(`${channelId}:${threadTs}`)
  // Bound the thread set — old entries stop mattering once threads go idle.
  if (answeredThreads.size > 2000) {
    const first = answeredThreads.values().next().value
    answeredThreads.delete(first)
  }
}

/** Test helper. */
export function _resetParticipationStateForTest(): void {
  lastReplyByChannel.clear()
  answeredThreads.clear()
}

// ─── Output safety ──────────────────────────────────────────

/** Channel replies are visible to the whole channel — never volunteer money. */
const FINANCIAL_RE = /\$\s?\d|\bbudget\b|\brevenue\b|\bmargin\b|\brate card\b|\binvoice\b|\bday rate\b/i


// ─── Decision ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Kit, a production agent embedded in a video studio's Slack project channel. A teammate just posted a message (they did NOT address you). Decide whether you can add clear value by replying — and stay QUIET unless you are sure.

You will receive context blocks (any may be empty):
- PROJECT: the channel's project — status, delivery date, links (Frame.io / Dropbox)
- KNOWLEDGE: retrieved from the project's brain, notes, and knowledge base
- DASHBOARD: structured project state — milestones, open action items
- FEEDBACK: open feedback items on the project
- LAST CALL: the most recent call transcript excerpt
- CANVASES: the channel's Slack canvases (team-maintained docs/dashboards)
- FRAMEIO COMMENTS: recent review comments on the latest cuts
- THREAD: earlier messages in the thread the question was asked in
- CHANNEL HISTORY: recent messages in this channel (oldest first)
- TEAM: the studio roster (for routing questions to a person)
- MESSAGE: what was posted

Output JSON ONLY:
{
  "action": "answer" | "asset" | "ping" | "quiet",
  "confidence": <0.0..1.0>,
  "reply": "<the exact message to post, or empty for quiet>",
  "mention_user_id": "<Slack id from TEAM, only for action=ping, else null>"
}

Rules:
- "answer": ONLY when one of the context blocks clearly and directly contains the answer. Answer in 1-3 sentences, state the fact plainly, and name where it comes from (e.g. "per the project brain", "per the channel canvas", "from Tuesday's call", "per the Frame.io comments on v3"). NEVER answer from general knowledge or guesses — if the context doesn't contain it, you don't know it.
- CHANNEL HISTORY and THREAD record what people SAID — attribute, don't assert: "Jonathan said Thursday works, a few messages up" not "the deadline is Thursday". If people contradicted each other, say so instead of picking a side.
- If THREAD shows the question was already answered, output "quiet" — don't repeat teammates.
- "asset": the message asks for a link/location the PROJECT record has (Frame.io project, Dropbox folder). Reply with the link and nothing else fancy.
- "ping": the question needs a HUMAN (a decision, approval, creative preference, or knowledge Kit lacks) AND one specific TEAM member is the obvious owner given their role. Reply like a helpful teammate: "That one's for <@ID> I think." Use this SPARINGLY.
- "quiet": everything else. Rhetorical questions, banter, questions already being discussed, anything you're not certain about. When in doubt: quiet.
- NEVER mention budgets, rates, costs, or any financial figure — this is a shared channel.
- Match the channel's tone: brief, casual, no corporate voice, at most one emoji.
- Confidence: 0.9+ only when the context match is exact; below 0.8 output "quiet" instead.`

export interface ParticipateArgs {
  app: App
  workspaceId: string
  channelId: string
  userId: string
  messageText: string
  messageTs: string
  threadTs?: string
}

/**
 * Consider replying to a channel message unprompted. Fire-and-forget from the
 * message handler — never throws, never blocks the pipeline.
 */
export async function maybeParticipate(args: ParticipateArgs): Promise<void> {
  try {
    if (!participationEnabled()) return
    if (!looksAddressable(args.messageText)) return

    const threadKey = args.threadTs || args.messageTs
    if (threadAlreadyAnswered(args.channelId, threadKey)) return
    if (underCooldown(args.channelId)) return

    // Retrieval-first: gather every groundable source in parallel — brain +
    // knowledge base, structured project state, feedback, latest transcript,
    // channel canvases, chat history + current thread, and (when the message
    // is review-flavored) live Frame.io comments. No signal → nothing to say.
    const ctx = await gatherParticipationContext({
      app: args.app,
      workspaceId: args.workspaceId,
      channelId: args.channelId,
      messageText: args.messageText,
      messageTs: args.messageTs,
      threadTs: args.threadTs,
    })
    if (!ctx.hasAnySignal) return
    const project = ctx.project
    const roster = ctx.roster

    const userPrompt = `PROJECT: ${
      project
        ? `${project.name}${project.frameioUrl ? ` · Frame.io: ${project.frameioUrl}` : ''}${project.dropboxUrl ? ` · Dropbox: ${project.dropboxUrl}` : ''}`
        : '(no linked project)'
    }

KNOWLEDGE:
${ctx.knowledgeBlock || '(nothing relevant retrieved)'}

DASHBOARD:
${ctx.dashboardBlock || '(none)'}

FEEDBACK:
${ctx.feedbackBlock || '(none open)'}

LAST CALL:
${ctx.transcriptBlock || '(no transcript)'}

CANVASES:
${ctx.canvasBlock || '(none)'}

FRAMEIO COMMENTS:
${ctx.frameioBlock || '(not fetched or none)'}

THREAD:
${ctx.threadBlock || '(not in a thread)'}

CHANNEL HISTORY (recent, oldest first):
${ctx.historyBlock || '(none)'}

TEAM:
${roster.map((m) => `- ${m.name} (${m.role}) → ${m.slackId}`).join('\n') || '(unknown)'}

MESSAGE (from a teammate, not addressed to you):
"""
${args.messageText}
"""

Decide. Output JSON only.`

    const res = await anthropic.messages.create({
      model: SPECIALIST_MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })
    const text = (res.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
    const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()
    let decision: any
    try {
      decision = JSON.parse(cleaned)
    } catch {
      return
    }

    const action = decision.action
    const confidence = Number(decision.confidence) || 0
    let reply = String(decision.reply || '').trim()
    if (action === 'quiet' || !reply) return
    if (!['answer', 'asset', 'ping'].includes(action)) return
    if (confidence < (MIN_CONF[action] ?? 1)) return

    // Output guards: no financials in-channel; pings must reference a real
    // roster member and actually carry the mention.
    if (FINANCIAL_RE.test(reply)) return
    if (action === 'ping') {
      const target = String(decision.mention_user_id || '')
      if (!roster.some((m) => m.slackId === target)) return
      if (!reply.includes(`<@${target}>`)) reply = `${reply} <@${target}>`
    }

    recordReply(args.channelId, threadKey)
    await args.app.client.chat.postMessage({
      channel: args.channelId,
      thread_ts: threadKey,
      text: reply,
    })
    console.log(
      `[participation] replied in ${args.channelId} (${action}, conf ${confidence.toFixed(2)})`,
    )
  } catch (err: any) {
    console.warn('[participation] failed (staying quiet):', err?.message || err)
  }
}
