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

    // Skip bot/system messages
    if (msgEvent.bot_id || msgEvent.subtype) return

    const isDM = msgEvent.channel_type === 'im'
    const userId = msgEvent.user
    const channelId = msgEvent.channel
    const teamId = msgEvent.team || ''

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
