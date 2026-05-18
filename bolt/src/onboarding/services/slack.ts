// @ts-nocheck
/**
 * Onboarding — Slack service
 *
 * Two operations + one read:
 *   1. Ensure the artist is in the workspace (admin.users.invite if needed)
 *   2. Invite the artist to the project channel
 *   3. fetchWelcomeCanvas() — read the editable freelancer welcome canvas
 *
 * The workspace invite requires SLACK_ADMIN_TOKEN (a user token belonging
 * to a workspace admin or owner, with admin.invites:write scope). The
 * bot token doesn't have admin scopes.
 */

import type { ServiceResult } from '../types'

const SLACK_API = 'https://slack.com/api'

function botToken(): string {
  return process.env.SLACK_BOT_TOKEN!
}
function adminToken(): string | undefined {
  return process.env.SLACK_ADMIN_TOKEN
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
 * Invite an external user to the workspace (admin scope required).
 * Returns the resulting Slack user id, or throws.
 */
async function adminInvite(email: string, realName?: string): Promise<string> {
  const token = adminToken()
  if (!token) {
    throw new Error('SLACK_ADMIN_TOKEN not set — cannot invite to workspace')
  }
  // admin.users.invite is form-encoded, not JSON.
  const form = new URLSearchParams({ email })
  if (realName) form.set('real_name', realName)
  const res = await fetch(`${SLACK_API}/admin.users.invite`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(10_000),
  })
  const data = await res.json()
  if (!data.ok) {
    // 'already_in_team' means we can just look them up
    if (data.error === 'already_in_team' || data.error === 'already_invited') {
      const existing = await lookupByEmail(email)
      if (existing) return existing
    }
    throw new Error(`admin.users.invite: ${data.error}`)
  }
  // Slack returns the invited user's id when the invite is accepted, but the
  // initial invite response often only confirms creation. Look up by email
  // — invites create a pending user that lookupByEmail can find.
  const id = await lookupByEmail(email)
  if (!id) {
    throw new Error('invite sent but user not yet visible via lookup')
  }
  return id
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

/**
 * Top-level entry: ensure the artist is in the workspace and the channel.
 */
export async function inviteArtistToSlack(opts: {
  email: string
  fullName: string
  projectChannelId: string | null
}): Promise<ServiceResult> {
  const { email, fullName, projectChannelId } = opts
  try {
    let userId = await lookupByEmail(email)
    if (!userId) {
      userId = await adminInvite(email, fullName)
    }
    if (!projectChannelId) {
      return {
        status: 'ok',
        message: `Artist in workspace as <@${userId}>; no project channel on file to invite them to.`,
        slackUserId: userId,
      }
    }
    await inviteToChannel(projectChannelId, userId)
    return {
      status: 'ok',
      message: `Invited <@${userId}> to <#${projectChannelId}>`,
      slackUserId: userId,
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
