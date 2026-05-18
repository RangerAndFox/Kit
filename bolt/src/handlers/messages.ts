// @ts-nocheck
/**
 * Bolt Message Handlers
 *
 * Three paths:
 *   1. Frame.io link detected → handleFrameIoLink (direct, no LLM)
 *   2. Time-entry shorthand detected → handleTimeEntry (direct, no LLM)
 *   3. Everything else → orchestrator (Claude)
 *
 * Triggers:
 *   - app_mention: any @mention in a channel where Kit is invited
 *   - message (DM): any message in a DM with Kit
 *   - message (channel, no mention): only if Kit is awaitingClarification
 *     from this (channel, user) within the TTL — enables follow-ups
 *     without requiring re-@mention.
 *
 * All replies post in the main flow (no thread_ts).
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { resolveUserContext } from '../../../src/lib/inngest/access-control'
import { messageHasFrameIoLink, handleFrameIoLink } from '../../../src/lib/frameio/slack-handler'
import { isTimeEntryMessage, handleTimeEntry } from '../../../src/lib/harvest/slack-handler'

import { runOrchestrator } from '../llm/orchestrator'
import { hasPendingClarification } from '../llm/memory'
import { setThinking, clearThinking } from '../llm/status'
import { buildStoryboardModal } from '../../../src/lib/storyboard/modal'
import { stashIntake } from '../../../src/lib/storyboard/stash'
import { projectNameFromFilename } from '../../../src/lib/storyboard/parser'
import { buildNewProjectCard } from './newproject-card'
import { findOpenCheckin, handleCheckinReply } from '../checkins/reply'

export function registerMessageHandlers(app: App) {
  // ─── @mentions ────────────────────────────────────────────
  app.event('app_mention', async ({ event }) => {
    if (event.bot_id || (event as any).subtype === 'bot_message') return

    const ev = event as any
    const channelId = ev.channel
    const messageText = (ev.text || '').replace(/<@[A-Z0-9]+>/g, '').trim()
    const userId = ev.user
    const teamId = ev.team || ''

    // Channel @mentions reply in main channel flow (no thread_ts)
    // even if Slack tagged them with an assistant_thread.
    await handleConversationalMessage({
      app,
      channelId,
      userId,
      teamId,
      messageText,
      messageTs: ev.ts,
      threadTs: ev.thread_ts || ev.ts,
      isDirectMention: true,
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
        const assistantThreadTs =
          msgEvent.assistant_thread && msgEvent.thread_ts
            ? msgEvent.thread_ts
            : undefined
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

    // Skip other system/edit/delete subtypes
    if (msgEvent.subtype) return

    const isDM = msgEvent.channel_type === 'im'
    const userId = msgEvent.user
    const channelId = msgEvent.channel
    const teamId = msgEvent.team || ''

    // ── Storyboard keyword shortcut (DM only) ─────────────
    // Strict match: the message must be a clear "make me a storyboard"
    // intent, not just any mention of the word. The orchestrator handles
    // looser phrasings conversationally.
    if (isDM && isStoryboardTrigger((msgEvent.text || '').trim())) {
      const assistantThreadTs =
        msgEvent.assistant_thread && msgEvent.thread_ts
          ? msgEvent.thread_ts
          : undefined
      await handleStoryboardKeyword({
        app,
        channelId,
        userId,
        assistantThreadTs,
      })
      return
    }

    // ── New-project keyword shortcut (DM only) ────────────
    if (isDM && isNewProjectTrigger((msgEvent.text || '').trim())) {
      const assistantThreadTs =
        msgEvent.assistant_thread && msgEvent.thread_ts
          ? msgEvent.thread_ts
          : undefined
      await app.client.chat.postMessage(
        buildNewProjectCard(channelId, assistantThreadTs),
      )
      return
    }

    // For non-DM messages without @mention, only act if Kit is awaiting clarification
    if (!isDM) {
      if (!hasPendingClarification(teamId, channelId, userId)) return
    }

    // (App_mention event handles the @mention path; ignore mentions here to avoid double-fire)
    if ((msgEvent.text || '').includes('<@') && !isDM) return

    // For DMs in a Slack Assistant thread (Agents & AI Apps), Slack
    // populates `thread_ts` AND attaches an `assistant_thread` block.
    // Replies must be threaded so they appear inside the user's view.
    const assistantThreadTs =
      isDM && msgEvent.assistant_thread && msgEvent.thread_ts
        ? msgEvent.thread_ts
        : undefined

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

  // Determine where the reply should land:
  //  - In an Assistant thread (DM with AI Apps): thread the reply so it
  //    appears inside the user's assistant conversation.
  //  - In any shared channel @mention: post in main flow (no thread_ts)
  //    so it's visible to the channel, not buried in a thread.
  const replyThreadTs = assistantThreadTs

  const postReply = async (text: string) => {
    await app.client.chat.postMessage({
      channel: channelId,
      text,
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
  }

  // Resolve workspace + user context
  const workspaceId = await resolveWorkspaceId(teamId)

  // Look up the Slack user's email so resolveUserContext can apply the
  // hardcoded-admin override (founder access works before team_members is seeded).
  let userEmail: string | undefined
  try {
    const info = await app.client.users.info({ user: userId })
    userEmail = info.user?.profile?.email || undefined
  } catch (err) {
    console.warn('[Bolt] users.info lookup failed:', (err as any)?.message)
  }

  const user = workspaceId
    ? await resolveUserContext(workspaceId, userId, userEmail)
    : null

  // Resolve project from channel (if this is a project channel)
  // and inject as context so Kit knows what "this project" means.
  const channelProject = workspaceId
    ? await resolveProjectFromChannel(workspaceId, channelId)
    : null

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

  // ── Fast path 2: Time entry shorthand ───────────────────
  if (isTimeEntryMessage(messageText)) {
    console.log('[Bolt] Time-entry shorthand detected')
    await handleTimeEntry({
      text: messageText,
      channelId,
      threadTs,
      messageTs,
      userId,
      workspaceId: workspaceId || '',
    })
    return
  }

  // ── Path 3: Orchestrator ────────────────────────────────
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
    const augmentedMessage = `${contextLines.join('\n')}\n\n${messageText}`

    const { reply } = await runOrchestrator({
      teamId,
      channel: channelId,
      userId,
      user,
      message: augmentedMessage,
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
 * Projects store their provisioned slack channel id in
 * `service_links.slack_id` after `/kit newproject`.
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
      .select('name, client, project_code, service_links')
      .eq('workspace_id', workspaceId)
      .filter('service_links->>slack_id', 'eq', channelId)
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
  } catch {
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

/** Wrapper for the Assistant-thread caller (app.ts). */
export async function handleNewProjectKeywordFromAssistant(
  app: App,
  opts: { channelId: string; assistantThreadTs?: string },
): Promise<void> {
  await app.client.chat.postMessage(
    buildNewProjectCard(opts.channelId, opts.assistantThreadTs),
  )
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

/** Wrapper for the Assistant-thread caller (app.ts). */
export async function handleStoryboardKeywordFromAssistant(
  app: App,
  opts: {
    channelId: string
    userId: string
    assistantThreadTs?: string
  },
): Promise<void> {
  return handleStoryboardKeyword({ app, ...opts })
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

async function resolveWorkspaceId(teamId: string): Promise<string> {
  if (!teamId) return ''
  try {
    const supabase = createAdminClient()
    const { data } = await supabase
      .from('workspaces')
      .select('id, slack_team_id')
      .eq('slack_team_id', teamId)
      .limit(1)
      .single()

    if (data?.id) return data.id

    const { data: first } = await supabase
      .from('workspaces')
      .select('id')
      .limit(1)
      .single()

    return first?.id || ''
  } catch {
    return ''
  }
}
