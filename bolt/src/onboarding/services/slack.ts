/**
 * Onboarding — Slack service
 *
 * Existing users are invited without changing their role. Guest restrictions
 * require Slack's admin-managed channel controls. New artists must be invited
 * as guests by an admin; Slack Connect is not a substitute for a guest account.
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
async function lookupByEmail(email: string): Promise<{ id: string; is_restricted?: boolean; is_ultra_restricted?: boolean; deleted?: boolean } | null> {
  const r = await slackGet('users.lookupByEmail', { email })
  if (!r.ok) {
    if (r.error === 'users_not_found') return null
    throw new Error(`users.lookupByEmail: ${r.error}`)
  }
  return r.user?.id ? r.user : null
}

/** Verify access, including guests who were added manually by an admin. */
async function isChannelMember(channelId: string, userId: string): Promise<boolean> {
  let cursor = ''
  const seen = new Set<string>()
  do {
    const r = await slackGet('conversations.members', { channel: channelId, limit: '200', ...(cursor ? { cursor } : {}) })
    if (!r.ok) throw new Error(`conversations.members: ${r.error}`)
    if (r.members?.includes(userId)) return true
    cursor = r.response_metadata?.next_cursor?.trim() || ''
    if (cursor && seen.has(cursor)) throw new Error('Slack membership pagination did not advance')
    seen.add(cursor)
  } while (cursor)
  return false
}

function guestAccessRequired(userId: string, channelId: string, singleChannel: boolean): SlackInviteResult {
  return {
    status: 'failed',
    slackUserId: userId,
    message: `Slack requires a workspace admin to add this ${singleChannel ? 'single-channel' : 'multi-channel'} guest to <#${channelId}>. ` +
      `In Slack: Manage members → <@${userId}> → Edit channels → add only this project channel. ` +
      (singleChannel ? 'A single-channel guest cannot join a second channel without an admin-approved role change. ' : '') +
      'Kit has not changed their role or other channels. After the admin saves, retry onboarding to verify access.',
  }
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
 *  - Non-member               → explicit admin guest-invitation handoff
 *
 * `projectChannelId` should come from `project.external_links.slack_id`
 * (the channel id the Kit provisioner stored at project creation).
 */
export async function inviteArtistToSlack(opts: {
  email: string
  fullName: string
  projectChannelId: string | null
}): Promise<SlackInviteResult> {
  const { email, projectChannelId } = opts
  let knownUserId: string | undefined

  if (!projectChannelId) {
    return {
      status: 'skipped',
      message: 'No slack_channel_id on the project — nothing to invite them to.',
    }
  }

  try {
    const user = await lookupByEmail(email)
    const userId = user?.id
    knownUserId = userId

    if (userId) {
      if (user.deleted) return { status: 'failed', slackUserId: userId, message: 'Slack account is deactivated. An admin must review it; Kit will not reactivate or change its role.' }
      if (await isChannelMember(projectChannelId, userId)) {
        return { status: 'ok', message: `<@${userId}> already has access to <#${projectChannelId}> (verified).`, slackUserId: userId }
      }
      // Already in the workspace — straight channel invite.
      try {
        await inviteToChannel(projectChannelId, userId)
      } catch (err) {
        // Do not convert a guest, replace their channels, or fall back to
        // Slack Connect. An uncertain invitation is reconciled by reading.
        if (await isChannelMember(projectChannelId, userId)) {
          return { status: 'ok', message: `Access to <#${projectChannelId}> verified for <@${userId}>.`, slackUserId: userId }
        }
        if (err instanceof Error && /user_is_restricted|ura_max_channels/.test(err.message)) {
          return guestAccessRequired(userId, projectChannelId, !!user.is_ultra_restricted)
        }
        throw err
      }
      return {
        status: 'ok',
        message: `Invited <@${userId}> to <#${projectChannelId}>`,
        slackUserId: userId,
      }
    }

    // Business+ bot tokens cannot create workspace guests. Never silently
    // substitute a full member or Slack Connect organization invitation.
    return {
      status: 'failed',
      message: `A Slack workspace admin must invite ${email} as a guest to <#${projectChannelId}>. ` +
        'Do not use a regular-member or Slack Connect invitation. Once the guest is available, retry onboarding to verify access and send the welcome DM.',
    }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err), ...(knownUserId ? { slackUserId: knownUserId } : {}) }
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
