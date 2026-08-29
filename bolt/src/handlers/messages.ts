// @ts-nocheck
/**
 * Bolt Message Handlers
 *
 * Paths (in order):
 *   1. Open daily-hours check-in for this user → check-in reply parser
 *   2. Frame.io link detected → handleFrameIoLink (direct, no LLM)
 *   3. DM mentions hours → ad-hoc parse + confirmation card
 *   4. Message mentions "onboard" → freelancer onboarding flow
 *   5. Everything else → orchestrator (Claude)
 *
 * Triggers:
 *   - app_mention: any @mention in a channel where Kit is invited
 *   - message (DM): any message in a DM with Kit
 *   - message (channel, no mention): only if Kit is awaitingClarification
 *     from this (channel, user) within the TTL — enables follow-ups
 *     without requiring re-@mention.
 *
 * Reply threading: DM replies (the Assistant / AI-Apps pane) always thread to
 * the conversation root so they stay inside the user's view; channel @mention
 * replies post in the main flow so the whole channel sees them.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { guardSharedSlackReply } from '../../../src/lib/privacy/shared-surface'
import { resolveUserContext } from '../../../src/lib/inngest/access-control'
import { messageHasFrameIoLink, handleFrameIoLink } from '../../../src/lib/frameio/slack-handler'
import { handleAdhocHoursEntry, looksLikeHoursIntent } from '../checkins/adhoc'
import { handleOnboardKeyword, isOnboardTrigger } from '../onboarding/keyword'
import { getPendingOnboarding } from '../onboarding/state'
import { isNoteTrigger } from '../notes/keyword'
import { handleNoteMessage } from '../notes/handler'
import { handleBrainIngestMessage } from '../brain/handler'
import { handleRoleMessage } from '../roles/handler'
import { handleFrameioToggleMessage } from '../delivery/frameio-toggle'
import { handleSpecIntakeReply } from '../delivery/spec-intake'
import { channelHasOpenSpecIntake } from '../../../src/lib/delivery/spec-intake-store'
import { maybeParticipate } from '../participation/participant'

import { runOrchestrator } from '../llm/orchestrator'
import { hasPendingClarification } from '../llm/memory'
import { setThinking, clearThinking } from '../llm/status'
import { stashIntake } from '../../../src/lib/storyboard/stash'
import { projectNameFromFilename } from '../../../src/lib/storyboard/parser'
import { buildNewProjectCard } from './newproject-card'
import { isUpdateProjectTrigger } from './updateproject-card'
import { buildUpdateProjectCardForContext } from './interactions'
import { buildArchiveCardForContext } from '../archive/handlers'
import { dashboardBaseUrl } from './dashboard-card'
import { isArchiveTrigger } from '../../../src/lib/archive/types'
import {
  findOpenCheckin,
  handleCheckinReply,
  handleParsedCheckinText,
} from '../checkins/reply'

/**
 * The thread ts to reply into for a DM (Slack Assistant / "Agents & AI Apps"
 * pane). Replies MUST be threaded to the conversation root to appear inside the
 * user's assistant view — a non-threaded reply lands in the main DM flow (the
 * "History" pane) and looks like it "randomly" left the thread.
 *
 * We can't gate on the `assistant_thread` block: Slack doesn't attach it to
 * every message event, so gating on it lets some replies escape. In a DM we
 * always thread to `thread_ts` (falling back to the message's own ts for the
 * rare top-level event). Returns undefined outside DMs — channel @mentions
 * post in the main flow by design so they're visible to the whole channel.
 */
function dmThreadTs(m: any): string | undefined {
  if (m?.channel_type !== 'im') return undefined
  return m.thread_ts || m.ts
}

// Kit's own bot user id, fetched lazily and cached for the process. Used to
// distinguish "this message @mentions Kit" (app_mention will fire — skip
// here) from "this message mentions someone else" (handle it here).
let _botUserId: string | null = null
async function getBotUserId(app: App): Promise<string | null> {
  if (_botUserId) return _botUserId
  try {
    const auth = await app.client.auth.test()
    _botUserId = (auth as any).user_id || null
  } catch (err: any) {
    console.warn('[Bolt] auth.test failed:', err?.message)
  }
  return _botUserId
}

// Each staffer's personal one-person Kit channel id (staff.briefing_channel_id).
// New scheduled hours reminders use Kit's DM, but older open reminders and
// manually initiated flows may still live in this private channel. Keep routing
// replies there through the check-in parser; other private-channel messages
// otherwise early-return unhandled. Cache the id (TTL) so this costs a Map hit,
// not a Supabase query, per message.
const personalChannelCache = new Map<string, { channelId: string; at: number }>()
const PERSONAL_CHANNEL_TTL_MS = 10 * 60 * 1000

async function personalKitChannelFor(slackUserId: string): Promise<string | null> {
  const hit = personalChannelCache.get(slackUserId)
  if (hit && Date.now() - hit.at < PERSONAL_CHANNEL_TTL_MS) return hit.channelId
  let channelId: string | null = null
  try {
    const sb = createAdminClient()
    const { data } = await sb
      .from('staff')
      .select('briefing_channel_id')
      .eq('slack_user_id', slackUserId)
      .maybeSingle()
    channelId = data?.briefing_channel_id || null
  } catch (err: any) {
    console.warn('[Bolt] personalKitChannelFor lookup failed:', err?.message || err)
  }
  // Cache only a positive binding. A newly provisioned channel or a transient
  // lookup failure must be visible on the very next message, not hidden behind
  // a ten-minute negative cache that drops the first hours reply.
  if (channelId) personalChannelCache.set(slackUserId, { channelId, at: Date.now() })
  return channelId
}

/**
 * Route a message in a user's personal Kit channel through the same check-in
 * reply path as a DM: an open check-in's reply/skip, then a typed confirm. The
 * check-in flow is channel-agnostic (it posts to the row's dm_channel_id, which
 * for a scheduled reminder is this channel). Returns true iff handled.
 */
async function handlePersonalChannelCheckinReply(opts: {
  app: App
  userId: string
  channelId: string
  messageText: string
  messageTs: string
}): Promise<boolean> {
  const { app, userId, channelId, messageText, messageTs } = opts
  const open = await findOpenCheckin(userId)
  if (open) {
    const handled = await handleCheckinReply({ app, open, replyText: messageText, replyTs: messageTs })
    if (handled) return true
  }
  return handleParsedCheckinText({
    app,
    slackUserId: userId,
    replyText: messageText,
    responseChannelId: channelId,
  })
}

export function registerMessageHandlers(app: App) {
  // ─── @mentions ────────────────────────────────────────────
  app.event('app_mention', async ({ event }) => {
    if (event.bot_id || (event as any).subtype === 'bot_message') return

    const ev = event as any
    const channelId = ev.channel
    const messageText = (ev.text || '').replace(/<@[A-Z0-9]+>/g, '').trim()
    const userId = ev.user
    const teamId = ev.team || ''

    // A top-level @mention replies in the main channel flow (visible to
    // everyone). But an @mention made INSIDE an existing thread must stay in
    // that thread — otherwise Kit's answer jumps out to the channel root and
    // looks like it "left the thread". thread_ts is set (and differs from the
    // message's own ts) only for messages that live inside a thread.
    const inThread = Boolean(ev.thread_ts && ev.thread_ts !== ev.ts)
    await handleConversationalMessage({
      app,
      channelId,
      userId,
      teamId,
      messageText,
      messageTs: ev.ts,
      threadTs: ev.thread_ts || ev.ts,
      isDirectMention: true,
      assistantThreadTs: inThread ? ev.thread_ts : undefined,
    })
  })

  // ─── DMs and channel-with-pending-clarification ───────────
  app.event('message', async ({ event }) => {
    const msgEvent = event as any

    // Skip bot messages always
    if (msgEvent.bot_id) return

    // ── Storyboard file drop (DM only) ────────────────────
    // file_share carries subtype: 'file_share' and a files[] array.
    // We special-case this BEFORE the generic subtype skip so .docx/.txt
    // uploads trigger the storyboard intake card.
    if (
      msgEvent.subtype === 'file_share' &&
      msgEvent.channel_type === 'im' &&
      Array.isArray(msgEvent.files) &&
      msgEvent.files.length > 0
    ) {
      const scriptFile = msgEvent.files.find(isStoryboardScriptFile)
      if (scriptFile) {
        const assistantThreadTs = dmThreadTs(msgEvent)
        await handleStoryboardFileDrop({
          app,
          file: scriptFile,
          channelId: msgEvent.channel,
          userId: msgEvent.user,
          assistantThreadTs,
        })
        return
      }
    }

    // ── Delivery spec intake (reply in a specs-prompt thread) ──
    // Runs BEFORE the subtype skip so file_share replies (PDF/screenshot)
    // are caught too. Returns false (and we continue) when the thread isn't
    // an open delivery prompt. channelHasOpenSpecIntake is a cached Set
    // lookup — without it every threaded message in every channel paid a
    // Supabase query.
    if (
      msgEvent.thread_ts &&
      msgEvent.channel &&
      msgEvent.user &&
      (await channelHasOpenSpecIntake(msgEvent.channel))
    ) {
      try {
        const handled = await handleSpecIntakeReply({
          app,
          channelId: msgEvent.channel,
          threadTs: msgEvent.thread_ts,
          userId: msgEvent.user,
          text: msgEvent.text || '',
          files: Array.isArray(msgEvent.files) ? msgEvent.files : [],
        })
        if (handled) return
      } catch (err: any) {
        console.error('[Bolt] spec intake reply failed:', err.message || err)
      }
    }

    // Skip other system/edit/delete subtypes
    if (msgEvent.subtype) return

    const isDM = msgEvent.channel_type === 'im'
    const userId = msgEvent.user
    const channelId = msgEvent.channel
    const teamId = msgEvent.team || ''

    // ── Daily-hours reminder reply (personal Kit channel) ──
    // Older hours reminders may remain open in the recipient's private
    // one-person Kit channel. A reply there must reach the check-in parser, but
    // unrelated private-channel messages still return below. Gate cheaply: only
    // private channels (not public 'channel', not DMs)
    // whose id matches this user's cached personal Kit channel. Runs BEFORE
    // brain ingest so a hours reply isn't also fed to the brain.
    if (
      !isDM &&
      userId &&
      channelId &&
      msgEvent.channel_type !== 'channel' &&
      (msgEvent.text || '').trim().length > 0
    ) {
      const personal = await personalKitChannelFor(userId)
      if (personal && personal === channelId) {
        try {
          const handled = await handlePersonalChannelCheckinReply({
            app,
            userId,
            channelId,
            messageText: (msgEvent.text || '').trim(),
            messageTs: msgEvent.ts,
          })
          if (handled) return
        } catch (err: any) {
          console.error('[Bolt] personal-channel check-in reply failed:', err?.message || err)
        }
      }
    }

    // ── Brain ingest (channel messages only) ──────────────
    // Fire-and-forget: every non-bot, non-subtype channel message goes
    // through the brain writer if this channel has a brain. The writer
    // applies a cheap classifier first so most chatter never reaches
    // Claude. We deliberately run this BEFORE the early-return below
    // so non-@mention messages still feed the brain.
    if (!isDM && (msgEvent.text || '').trim().length > 0) {
      handleBrainIngestMessage({
        app,
        channelId,
        userId,
        messageText: msgEvent.text || '',
        messageTs: msgEvent.ts,
        threadTs: msgEvent.thread_ts,
      }).catch((err) => console.error('[Bolt] brain ingest failed:', err.message || err))

      // ── Channel participation (unprompted, high-precision) ──
      // Kit answers channel questions it can ground in the knowledge base,
      // shares project assets, or routes to the right teammate — without
      // being @mentioned. Heavily gated (prefilter → retrieval → confidence
      // floors → cooldowns) so it stays quiet unless it's sure. Skipped when
      // this message is about to be handled conversationally anyway.
      if (
        !hasPendingClarification(teamId, channelId, userId) &&
        !getPendingOnboarding(channelId, userId)
      ) {
        resolveWorkspaceId(teamId)
          .then((wsId) =>
            wsId
              ? maybeParticipate({
                  app,
                  workspaceId: wsId,
                  channelId,
                  userId,
                  messageText: msgEvent.text || '',
                  messageTs: msgEvent.ts,
                  threadTs: msgEvent.thread_ts,
                })
              : undefined,
          )
          .catch((err) => console.warn('[Bolt] participation failed:', err?.message || err))
      }
    }

    // ── Structured keyword shortcuts (DM only) ───────────
    if (isDM && await handleDmShortcut(app, {
      channelId,
      userId,
      teamId,
      text: (msgEvent.text || '').trim(),
      threadTs: dmThreadTs(msgEvent),
    })) {
      return
    }

    // For non-DM messages without @mention, only act if Kit is awaiting
    // clarification from the orchestrator OR has an active onboarding flow
    // for this user (so they can answer "what's the email?" without @mention).
    if (!isDM) {
      if (
        !hasPendingClarification(teamId, channelId, userId) &&
        !getPendingOnboarding(channelId, userId)
      )
        return
    }

    // (app_mention handles the @Kit path; ignore only messages that mention
    // KIT here to avoid double-fire. A clarification answer that mentions
    // someone ELSE — "it's <@UJARED>'s project" — must still be handled,
    // since app_mention never fires for it.)
    if (!isDM && (msgEvent.text || '').includes('<@')) {
      const botId = await getBotUserId(app)
      if (!botId || (msgEvent.text || '').includes(`<@${botId}>`)) return
    }

    // For DMs (the Slack Assistant / Agents & AI Apps pane) always thread the
    // reply to the conversation root so it appears inside the user's view.
    // We deliberately don't gate on the `assistant_thread` block — Slack omits
    // it on some events, which used to drop replies into the main DM flow.
    // In a channel, a message that arrived inside a thread (clarification /
    // onboarding answer) must be answered in that same thread, not the root.
    const assistantThreadTs =
      dmThreadTs(msgEvent) ||
      (msgEvent.thread_ts && msgEvent.thread_ts !== msgEvent.ts
        ? msgEvent.thread_ts
        : undefined)

    await handleConversationalMessage({
      app,
      channelId,
      userId,
      teamId,
      messageText: (msgEvent.text || '').trim(),
      messageTs: msgEvent.ts,
      threadTs: msgEvent.thread_ts || msgEvent.ts,
      isDirectMention: false,
      channelType: msgEvent.channel_type,
      assistantThreadTs,
    })
  })
}

// ─── Shared handler ────────────────────────────────────────
export interface HandlerArgs {
  app: App
  channelId: string
  userId: string
  teamId: string
  messageText: string
  messageTs: string
  threadTs: string
  isDirectMention: boolean
  /** Slack channel type — 'im' for DMs */
  channelType?: string
  /**
   * If set, the message arrived inside a Slack Assistant thread
   * (Agents & AI Apps). Replies must be threaded with this ts to
   * appear inside the assistant conversation the user is viewing.
   */
  assistantThreadTs?: string
}

export async function handleConversationalMessage(args: HandlerArgs): Promise<void> {
  const {
    app,
    channelId,
    userId,
    teamId,
    messageText,
    messageTs,
    threadTs,
    channelType,
    assistantThreadTs,
  } = args

  // Determine where the reply should land (set by the caller):
  //  - DM / Assistant thread: thread to the conversation root.
  //  - Channel message already inside a thread: stay in that thread.
  //  - Top-level channel @mention: assistantThreadTs is undefined → post in
  //    the main flow so the answer is visible to the whole channel.
  const replyThreadTs = assistantThreadTs

  const postReply = async (text: string) => {
    const safeText = channelType === 'im' ? text : guardSharedSlackReply(text)
    await app.client.chat.postMessage({
      channel: channelId,
      text: safeText,
      ...(replyThreadTs ? { thread_ts: replyThreadTs } : {}),
    })
  }

  if (!messageText) {
    await postReply("Hey! What can I help you with?")
    return
  }

  // ── Daily-hours check-in interception ─────────────────────
  // If this is a DM (or assistant thread) and the user has an open
  // check-in for today, route the reply to the check-in parser instead
  // of the orchestrator. Prevents Kit from "having a conversation"
  // about hours when we already asked a structured question.
  if (channelType === 'im' || assistantThreadTs) {
    const open = await findOpenCheckin(userId)
    if (open) {
      const handled = await handleCheckinReply({
        app,
        open,
        replyText: messageText,
        replyTs: messageTs,
      })
      if (handled) return
    }

    // Parsed check-in awaiting confirmation: a typed "yes"/"redo" completes
    // it — the buttons' click events travel a Slack path that has proven
    // unreliable, so the flow can't depend on them.
    console.log(
      `[checkin] DM from ${userId} (channelType=${channelType}, hasAssistantThread=${!!assistantThreadTs}) text="${messageText.slice(0, 24)}" — checking parsed-confirm`,
    )
    const confirmed = await handleParsedCheckinText({
      app,
      slackUserId: userId,
      replyText: messageText,
    })
    if (confirmed) return
  }

  // Resolve workspace + user context. Workspace id and the user's email are
  // effectively constant — cached with a TTL so every message doesn't pay a
  // Supabase query + a Slack users.info round-trip before any routing.
  const workspaceId = await resolveWorkspaceId(teamId)
  const userEmail = await lookupUserEmail(app, userId)

  // User context + channel→project resolution are independent — run them in
  // parallel instead of serially.
  const [user, channelProject] = await Promise.all([
    workspaceId ? resolveUserContext(workspaceId, userId, userEmail) : Promise.resolve(null),
    workspaceId ? resolveProjectFromChannel(workspaceId, channelId) : Promise.resolve(null),
  ])

  // ── Fast path 1: Frame.io link ──────────────────────────
  if (messageHasFrameIoLink(messageText)) {
    console.log('[Bolt] Frame.io link detected')
    await handleFrameIoLink({
      text: messageText,
      channelId,
      threadTs,
      messageTs,
      userId,
      workspaceId: workspaceId || '',
    })
    return
  }

  // ── Fast path 2: Ad-hoc hours entry ─────────────────────
  // If this is a DM (or assistant thread) and the message mentions hours,
  // route it through the same parse/confirm/log pipeline as the daily
  // check-in. Falls through to the orchestrator if the LLM determines
  // the message isn't actually a time entry.
  if ((channelType === 'im' || assistantThreadTs) && looksLikeHoursIntent(messageText)) {
    const handled = await handleAdhocHoursEntry({
      app,
      slackUserId: userId,
      channelId,
      messageText,
      messageTs,
      threadTs: assistantThreadTs,
    })
    if (handled) return
  }

  // ── Fast path 3: Freelancer onboarding ──────────────────
  // Triggers when:
  //  - "@Kit onboard …" (or "onboard …" in a DM) is mentioned, OR
  //  - This user has a pending onboarding flow in this channel (they're
  //    answering an earlier "what's the email?" question without @Kit).
  //
  // Reply threading: thread only inside a DM Assistant thread; channel
  // @mentions post in main channel flow.
  const hasPendingOnboard = !!getPendingOnboarding(channelId, userId)
  if (isOnboardTrigger(messageText) || hasPendingOnboard) {
    const handled = await handleOnboardKeyword({
      app,
      channelId,
      threadTs: assistantThreadTs,
      userId,
      text: messageText,
    })
    if (handled) return
  }

  // ── Fast path 3.5: Role management ──────────────────────
  // Admin says "make @X a producer" / "@X role" in chat. Slash commands
  // aren't available in the Assistant/DM pane, so we handle it here.
  // Non-admins / non-matches fall through (handler returns false).
  try {
    const handledRole = await handleRoleMessage({
      app,
      channelId,
      userId,
      text: messageText,
      threadTs: assistantThreadTs,
    })
    if (handledRole) {
      await clearThinking(app, channelId, replyThreadTs || threadTs)
      return
    }
  } catch (err: any) {
    console.error('[Bolt] role handler failed:', err.message || err)
  }

  // ── Fast path 3.6: Frame.io upload toggle ───────────────
  // "@Kit turn off Frame.io upload" / "is frame upload on?" etc. Producers and
  // admins can change it; anyone can check status. Runs after the Frame.io
  // *link* fast path above, so review links are never captured here.
  try {
    const handledToggle = await handleFrameioToggleMessage({
      app,
      channelId,
      userId,
      text: messageText,
      threadTs: assistantThreadTs,
      workspaceId,
      caller: user,
    })
    if (handledToggle) {
      await clearThinking(app, channelId, replyThreadTs || threadTs)
      return
    }
  } catch (err: any) {
    console.error('[Bolt] frame.io toggle handler failed:', err.message || err)
  }

  // ── Fast path 4: Notes capture ───────────────────────────
  if (isNoteTrigger(messageText)) {
    try {
      const handled = await handleNoteMessage({
        app,
        channelId,
        userId,
        text: messageText,
      })
      if (handled) {
        await clearThinking(app, channelId, replyThreadTs || threadTs)
        return
      }
    } catch (err: any) {
      console.error('[Bolt] note handler failed:', err.message || err)
      // fall through to orchestrator
    }
  }

  // ── Path 6: Orchestrator ────────────────────────────────
  await setThinking(app, channelId, replyThreadTs || threadTs, 'thinking…')

  try {
    // Build a context preamble Kit always sees:
    //  - Who's talking (Slack user ID, name, tier when known)
    //  - Which project this channel belongs to (when known)
    // This means Kit never has to ask "who are you?" or "which project?"
    // when the answer is already in the request metadata.
    const contextLines: string[] = []
    contextLines.push(
      user
        ? `[You are talking to ${user.name} — Slack user <@${userId}>, ${user.tier} tier]`
        : `[You are talking to Slack user <@${userId}> (no team-member record found)]`,
    )
    if (channelProject) {
      contextLines.push(
        `[This conversation is in the Slack channel for project "${channelProject.name}"` +
          (channelProject.client ? ` (client: ${channelProject.client})` : '') +
          (channelProject.code ? `, code ${channelProject.code}` : '') +
          `. When the user says "this project" or omits a project, they mean this one.]`,
      )
    }
    // Preamble travels separately: it's injected into the current API call
    // only, so conversation memory stores clean turns (it used to bake one
    // copy of this header into every stored message).
    const { reply } = await runOrchestrator({
      teamId,
      channel: channelId,
      userId,
      user,
      message: messageText,
      contextPreamble: contextLines.join('\n'),
    })

    await postReply(reply)
  } catch (err: any) {
    console.error('[Bolt] orchestrator error:', err)
    const reason =
      err?.error?.error?.message ||
      err?.error?.message ||
      err?.message ||
      String(err)
    await postReply(`I'm having trouble thinking clearly — \`${reason.slice(0, 300)}\``)
  } finally {
    await clearThinking(app, channelId, replyThreadTs || threadTs)
  }
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Look up the project that owns this Slack channel, if any.
 *
 * The provisioner writes the channel id into `external_links.slack_id`
 * (see interactions.ts → projects.update({ external_links })). Older or
 * manually-linked rows may instead use `external_links.slack_channel_id`
 * or the top-level `slack_channel_id` column, so we match any of the
 * three — same resolution order the notes + brain paths use.
 *
 * (Previously this queried a `service_links` column that doesn't exist,
 * so it always threw → returned null → the "this is project X" context
 * line never reached the orchestrator and "this project" was ungrounded.)
 */
async function resolveProjectFromChannel(
  workspaceId: string,
  channelId: string,
): Promise<{ name: string; client: string | null; code: string | null } | null> {
  if (!workspaceId || !channelId) return null
  try {
    const supabase = createAdminClient()
    const { data } = await supabase
      .from('projects')
      .select('name, client, project_code')
      .eq('workspace_id', workspaceId)
      .or(
        `external_links->>slack_id.eq.${channelId},external_links->>slack_channel_id.eq.${channelId},slack_channel_id.eq.${channelId}`,
      )
      .limit(1)
      .maybeSingle()

    if (data?.name) {
      return {
        name: data.name,
        client: (data as any).client || null,
        code: (data as any).project_code || null,
      }
    }
    return null
  } catch (err: any) {
    console.warn('[Bolt] resolveProjectFromChannel failed:', err?.message)
    return null
  }
}

// ─── Storyboard intake helpers ─────────────────────────────

/**
 * Detect a Slack file that looks like a storyboard script source.
 * We accept .docx and plain text.
 */
export function isStoryboardScriptFile(f: any): boolean {
  const ft = String(f?.filetype || '').toLowerCase()
  const mt = String(f?.mimetype || '').toLowerCase()
  const name = String(f?.name || '').toLowerCase()
  if (ft === 'docx' || mt.includes('officedocument.wordprocessingml')) return true
  if (ft === 'text' || ft === 'txt' || mt.startsWith('text/')) return true
  if (name.endsWith('.docx') || name.endsWith('.txt')) return true
  return false
}

/**
 * Conservative keyword matcher. Returns true for messages whose entire
 * intent is "I want to create a storyboard now" — not for messages that
 * merely mention storyboarding in passing.
 */
/**
 * Conservative matcher for "I want to start a new project right now"
 * phrasings. Mirrors the storyboard trigger style: only strict, short
 * intents fire the shortcut; everything looser goes to the orchestrator.
 */
export function isNewProjectTrigger(text: string): boolean {
  if (!text) return false
  const t = text.toLowerCase().trim()
  if (t.length > 60) return false
  const exact = new Set([
    'new project',
    '/newproject',
    '/new project',
    'newproject',
    'make a project',
    'create a project',
    'create project',
    'make project',
    'start a project',
    'start project',
    'spin up a project',
    'spin up project',
    'new gig',
  ])
  if (exact.has(t)) return true
  return /^(new|make|create|start|spin up)\s+(a\s+)?project(\s+please)?\.?$/i.test(t)
}

/**
 * Strict DM shortcut for the founder Control Center. Keeping this matcher
 * narrow prevents ordinary questions that happen to mention a dashboard from
 * bypassing the conversational orchestrator.
 */
export function isDashboardTrigger(text: string): boolean {
  if (!text) return false
  const t = text.toLowerCase().trim().replace(/[.!?]+$/, '')
  if (t.length > 40) return false
  return new Set([
    'dashboard',
    'kit dashboard',
    '/kit dashboard',
    'control center',
    'kit control center',
    '/kit control',
  ]).has(t)
}

export function isStoryboardTrigger(text: string): boolean {
  if (!text) return false
  const t = text.toLowerCase().trim()
  if (t.length > 60) return false // long messages go to the orchestrator
  const exact = new Set([
    'storyboard',
    '/storyboard',
    'new storyboard',
    'make a storyboard',
    'create a storyboard',
    'create storyboard',
    'make storyboard',
    'start a storyboard',
    'script to storyboard',
    'script',
    'new script',
  ])
  if (exact.has(t)) return true
  // Common multi-word phrasings.
  return /^(new|make|create|start)\s+(a\s+)?storyboard(\s+please)?\.?$/i.test(t)
}

export interface DmShortcutContext {
  channelId: string
  userId: string
  teamId: string
  text: string
  threadTs?: string
}

/**
 * Slack can append a relay attribution when a message is sent into Kit from
 * another Slack AI app (for example, "Sent using @ChatGPT"). That annotation
 * is transport metadata, not part of the user's command. Keep the strict
 * shortcut matchers strict, but remove only this narrow trailing shape before
 * asking the registry to match it.
 */
export function normalizeDmShortcutText(text: string): string {
  let normalized = String(text || '').trim()
  if (!normalized) return ''

  const mention = '<@[A-Z0-9]+(?:\\|[^>]+)?>'
  const sentUsing = `(?:[_*~]*\\s*sent\\s+using\\s*[_*~]*\\s*)?${mention}`

  // Slack may serialize the attribution on its own line or directly after the
  // visible command. Requiring the suffix to end in a Slack user/app mention
  // prevents ordinary prose such as "new project for Steve" from matching.
  normalized = normalized.replace(new RegExp(`\\s+${sentUsing}\\s*$`, 'i'), '').trim()

  return normalized
}

type DmShortcut = {
  id: 'dashboard' | 'storyboard' | 'new-project' | 'update-project' | 'archive-project'
  matches: (text: string) => boolean
  run: (app: App, context: DmShortcutContext) => Promise<void>
}

/**
 * Canonical ordered registry for strict DM card shortcuts. Both Slack inbound
 * paths call handleDmShortcut, so adding an entry here makes it available in
 * Assistant threads and in the plain-message fallback at the same time.
 */
export const DM_SHORTCUT_REGISTRY: readonly DmShortcut[] = [
  {
    id: 'dashboard',
    matches: isDashboardTrigger,
    run: async (app, context) => {
      const post = async (message: Record<string, unknown>) => {
        await app.client.chat.postMessage({
          channel: context.channelId,
          ...(context.threadTs ? { thread_ts: context.threadTs } : {}),
          ...message,
        })
      }
      const workspaceId =
        (await resolveWorkspaceId(context.teamId)) ||
        process.env.KIT_DEFAULT_WORKSPACE_ID ||
        ''
      if (!workspaceId) {
        await post({ text: ':warning: Kit’s workspace has not been configured yet.' })
        return
      }
      const email = await lookupUserEmail(app, context.userId)
      const user = await resolveUserContext(workspaceId, context.userId, email)
      if (user?.tier !== 'admin') {
        await post({ text: ':lock: The Kit Control Center is currently founder/admin only.' })
        return
      }
      const baseUrl = dashboardBaseUrl()
      await post({
        text: 'Open the live Kit Control Center.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Kit Control Center*\nLive health, queues, usage, workers and project operations.',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                style: 'primary',
                text: { type: 'plain_text', text: 'Open dashboard' },
                url: `${baseUrl}/control-center`,
              },
            ],
          },
        ],
      })
    },
  },
  {
    id: 'storyboard',
    matches: isStoryboardTrigger,
    run: async (app, context) => handleStoryboardKeyword({
      app,
      channelId: context.channelId,
      userId: context.userId,
      assistantThreadTs: context.threadTs,
    }),
  },
  {
    id: 'new-project',
    matches: isNewProjectTrigger,
    run: async (app, context) => {
      await app.client.chat.postMessage(
        buildNewProjectCard(context.channelId, context.threadTs),
      )
    },
  },
  {
    id: 'update-project',
    matches: isUpdateProjectTrigger,
    run: async (app, context) => {
      const card = await buildUpdateProjectCardForContext({
        teamId: context.teamId,
        channelId: context.channelId,
        threadTs: context.threadTs,
        client: app.client,
      })
      await app.client.chat.postMessage(card)
    },
  },
  {
    id: 'archive-project',
    matches: isArchiveTrigger,
    run: async (app, context) => {
      const card = await buildArchiveCardForContext({
        teamId: context.teamId,
        channelId: context.channelId,
        userId: context.userId,
        client: app.client,
      })
      await app.client.chat.postMessage({
        channel: context.channelId,
        ...(context.threadTs ? { thread_ts: context.threadTs } : {}),
        ...card,
      })
    },
  },
]

export async function handleDmShortcut(
  app: App,
  context: DmShortcutContext,
): Promise<boolean> {
  const shortcutText = normalizeDmShortcutText(context.text)
  const shortcut = DM_SHORTCUT_REGISTRY.find((candidate) =>
    candidate.matches(shortcutText),
  )
  if (!shortcut) return false
  await shortcut.run(app, context)
  return true
}

/**
 * A user dropped a .docx/.txt in our DM. Stash a reference to the file
 * and post a card with a button that opens the settings modal pre-filled.
 * We don't download the file here — that happens at view-submit so we
 * don't waste bytes if the user abandons the modal.
 */
/** Wrapper for the Assistant-thread caller (app.ts). */
export async function handleStoryboardFileDropFromAssistant(
  app: App,
  opts: {
    file: any
    channelId: string
    userId: string
    assistantThreadTs?: string
  },
): Promise<void> {
  return handleStoryboardFileDrop({ app, ...opts })
}

async function handleStoryboardFileDrop(opts: {
  app: App
  file: any
  channelId: string
  userId: string
  assistantThreadTs?: string
}) {
  const { app, file, channelId, userId, assistantThreadTs } = opts
  const stashToken = stashIntake({
    channelId,
    userId,
    assistantThreadTs,
    suggestedName: projectNameFromFilename(file.name || ''),
    file: {
      id: file.id,
      url_private: file.url_private,
      name: file.name,
      filetype: file.filetype,
      mimetype: file.mimetype,
    },
  })

  await app.client.chat.postMessage({
    channel: channelId,
    ...(assistantThreadTs ? { thread_ts: assistantThreadTs } : {}),
    text: `Got *${file.name}* — open the storyboard settings to continue.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `:page_facing_up: Got *${file.name || 'your script'}*. ` +
            `Click below to set up the storyboard — I'll parse the script and create it in Boords.`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Open storyboard settings' },
            action_id: 'kit_open_storyboard_modal',
            value: stashToken,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Cancel' },
            action_id: 'kit_cancel_storyboard',
            value: stashToken,
          },
        ],
      },
    ],
  })
}

/**
 * A user typed a storyboard trigger phrase. Post the same card we'd post
 * for a file drop, minus the file ref — they'll paste a script into the
 * modal (or pick blank).
 */
async function handleStoryboardKeyword(opts: {
  app: App
  channelId: string
  userId: string
  assistantThreadTs?: string
}) {
  const { app, channelId, userId, assistantThreadTs } = opts
  const stashToken = stashIntake({ channelId, userId, assistantThreadTs })

  await app.client.chat.postMessage({
    channel: channelId,
    ...(assistantThreadTs ? { thread_ts: assistantThreadTs } : {}),
    text: 'Storyboard — pick your settings to start.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            ':clapper: *New storyboard.* Pick your settings — you can paste a script ' +
            'into the next step, or leave it empty for a blank storyboard.',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Open storyboard settings' },
            action_id: 'kit_open_storyboard_modal',
            value: stashToken,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Cancel' },
            action_id: 'kit_cancel_storyboard',
            value: stashToken,
          },
        ],
      },
    ],
  })
}

// Workspace ids never change at runtime and there's exactly one workspace in
// practice — cache per team so the hot path skips a Supabase query per
// message. (1h TTL just so a manually-added workspace is picked up.)
const WORKSPACE_CACHE_TTL_MS = 60 * 60 * 1000
const workspaceCache = new Map<string, { id: string; at: number }>()

async function resolveWorkspaceId(teamId: string): Promise<string> {
  if (!teamId) return ''
  const hit = workspaceCache.get(teamId)
  if (hit && Date.now() - hit.at < WORKSPACE_CACHE_TTL_MS) return hit.id
  try {
    const supabase = createAdminClient()
    const { data } = await supabase
      .from('workspaces')
      .select('id, slack_team_id')
      .eq('slack_team_id', teamId)
      .limit(1)
      .single()

    let id = data?.id || ''
    if (!id) {
      const { data: first } = await supabase
        .from('workspaces')
        .select('id')
        .limit(1)
        .single()
      id = first?.id || ''
    }
    if (id) workspaceCache.set(teamId, { id, at: Date.now() })
    return id
  } catch {
    return ''
  }
}

// Slack emails effectively never change mid-session — cache per user so the
// hot path skips a users.info round-trip per message. Failures are cached
// briefly too (missing users.read scope shouldn't hammer the API).
const EMAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const emailCache = new Map<string, { email: string | undefined; at: number }>()

async function lookupUserEmail(app: App, userId: string): Promise<string | undefined> {
  const hit = emailCache.get(userId)
  if (hit && Date.now() - hit.at < EMAIL_CACHE_TTL_MS) return hit.email
  let email: string | undefined
  try {
    const info = await app.client.users.info({ user: userId })
    email = info.user?.profile?.email || undefined
  } catch (err) {
    console.warn('[Bolt] users.info lookup failed:', (err as any)?.message)
  }
  emailCache.set(userId, { email, at: Date.now() })
  return email
}
