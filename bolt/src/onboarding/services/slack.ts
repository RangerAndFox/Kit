// @ts-nocheck
/**
 * Onboarding — Slack service
 *
 * Three flows depending on whether the artist already exists in the workspace:
 *
 *   A. Artist is already a workspace member
 *      → conversations.invite to the project channel (immediate access)
 *      → welcome DM via conversations.open (private message)
 *
 *   B. Artist is NOT a workspace member
 *      → conversations.inviteShared (Slack Connect invite) to the project channel
 *      → channel becomes a Connect channel when they accept
 *      → no immediate Slack user ID; welcome message is posted into the
 *        channel so they see it when they accept the invite
 *
 * Connect uses the bot's existing conversations.connect:write scope — no
 * admin scopes required, works on Business+ plans.
 */

import type { ServiceResult } from '../types'

const SLACK_API = 'https://slack.com/api'

function botToken(): string {
  return process.env.SLACK_BOT_TOKEN!
}

async function slackPostJson(method: string, body: any, token: string): Promise<any> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  return res.json()
}

async function slackGet(method: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${SLACK_API}/${method}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${botToken()}` },
    signal: AbortSignal.timeout(10_000),
  })
  return res.json()
}

/**
 * Look up a Slack user id by email. Returns null if not found.
 */
async function lookupByEmail(email: string): Promise<string | null> {
  const r = await slackGet('users.lookupByEmail', { email })
  if (!r.ok) {
    if (r.error === 'users_not_found') return null
    throw new Error(`users.lookupByEmail: ${r.error}`)
  }
  return r.user?.id || null
}

/**
 * Send a Slack Connect invite for a channel. The recipient gets an email
 * from Slack; when they accept, the channel becomes a Connect channel
 * shared with their workspace.
 *
 * Returns the invite id. The recipient is NOT yet a member of our
 * workspace — they won't have a Slack user id until acceptance.
 */
async function connectInvite(opts: {
  channelId: string
  email: string
}): Promise<string> {
  const r = await slackPostJson(
    'conversations.inviteShared',
    {
      channel: opts.channelId,
      emails: [opts.email],
      // false = full Connect (can see history, post, etc.); true = view-only-style.
      external_limited: false,
    },
    botToken(),
  )
  if (!r.ok) {
    throw new Error(`conversations.inviteShared: ${r.error}`)
  }
  return r.invite_id || r.invite?.id || 'unknown'
}

/**
 * Invite a user to a channel. Idempotent — 'already_in_channel' counts as ok.
 */
async function inviteToChannel(channelId: string, userId: string): Promise<void> {
  const r = await slackPostJson(
    'conversations.invite',
    { channel: channelId, users: userId },
    botToken(),
  )
  if (!r.ok) {
    if (r.error === 'already_in_channel') return
    throw new Error(`conversations.invite: ${r.error}`)
  }
}

export interface SlackInviteResult extends ServiceResult {
  /** True if a Slack Connect invite was sent and is awaiting acceptance. */
  connectPending?: boolean
}

/**
 * Top-level entry: get the artist access to the project channel.
 *  - Existing workspace member → conversations.invite (immediate)
 *  - Non-member               → conversations.inviteShared (Slack Connect, pending)
 */
export async function inviteArtistToSlack(opts: {
  email: string
  fullName: string
  projectChannelId: string | null
}): Promise<SlackInviteResult> {
  const { email, projectChannelId } = opts

  if (!projectChannelId) {
    return {
      status: 'skipped',
      message: 'No slack_channel_id on the project — nothing to invite them to.',
    }
  }

  try {
    const userId = await lookupByEmail(email)

    if (userId) {
      // Already in the workspace — straight channel invite.
      await inviteToChannel(projectChannelId, userId)
      return {
        status: 'ok',
        message: `Invited <@${userId}> to <#${projectChannelId}>`,
        slackUserId: userId,
      }
    }

    // Not in the workspace — send a Slack Connect invite to the channel.
    const inviteId = await connectInvite({ channelId: projectChannelId, email })
    return {
      status: 'ok',
      message: `Sent Slack Connect invite for <#${projectChannelId}> to ${email} (pending acceptance)`,
      externalId: inviteId,
      connectPending: true,
    }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err) }
  }
}

/**
 * Fetch the freelancer welcome canvas as markdown.
 * Returns null if no canvas is configured or the fetch fails.
 */
export async function fetchWelcomeCanvas(): Promise<string | null> {
  const fileId = process.env.SLACK_FREELANCER_WELCOME_CANVAS_ID
  if (!fileId) return null
  try {
    const info = await slackGet('files.info', { file: fileId })
    const url: string | undefined =
      info.file?.url_private_download || info.file?.url_private
    if (!url) return null
    const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken()}` } })
    if (!res.ok) return null
    return await res.text()
  } catch (err: any) {
    console.warn(`[onboarding/slack] fetchWelcomeCanvas failed: ${err.message}`)
    return null
  }
}

/**
 * Open a DM with the artist and post the welcome message.
 */
export async function sendWelcomeDm(opts: {
  artistSlackUserId: string
  text: string
}): Promise<ServiceResult> {
  try {
    const open = await slackPostJson(
      'conversations.open',
      { users: opts.artistSlackUserId },
      botToken(),
    )
    if (!open.ok) throw new Error(`conversations.open: ${open.error}`)
    const channel = open.channel?.id
    if (!channel) throw new Error('conversations.open returned no channel')
    const post = await slackPostJson(
      'chat.postMessage',
      { channel, text: opts.text },
      botToken(),
    )
    if (!post.ok) throw new Error(`chat.postMessage: ${post.error}`)
    return { status: 'ok', message: 'Welcome DM sent' }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err) }
  }
}
