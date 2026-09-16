/**
 * Onboarding — Slack service
 *
 * Guest-only, fail-closed onboarding. New guests require an admin invitation
 * on Business+ (Slack's supported admin invitation API is Enterprise-only).
 * Existing local guests are verified before and after project access changes.
 * Never create full members, send Connect invites, or silently change roles.
 */

import type { ServiceResult } from '../types'

const SLACK_API = 'https://slack.com/api'

interface SlackGuestUser {
  id: string
  team_id?: string
  is_restricted?: boolean
  is_ultra_restricted?: boolean
  deleted?: boolean
  is_bot?: boolean
  is_admin?: boolean
  is_owner?: boolean
  is_invited_user?: boolean
}

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
async function lookupByEmail(email: string): Promise<SlackGuestUser | null> {
  const r = await slackGet('users.lookupByEmail', { email })
  if (!r.ok) {
    if (r.error === 'users_not_found') return null
    throw new Error(`users.lookupByEmail: ${r.error}`)
  }
  if (!r.user?.id) throw new Error('Slack returned no verifiable user identity')
  return r.user
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
 * Top-level entry: get the artist access to the project channel.
 *  - Existing local guest → verify role, project membership, then welcome DM.
 *  - Missing/non-guest account → actionable admin step, never a fallback invite.
 *
 * `projectChannelId` should come from `project.external_links.slack_id`
 * (the channel id the Kit provisioner stored at project creation).
 */
export async function inviteArtistToSlack(opts: {
  email: string
  fullName: string
  projectChannelId: string | null
}): Promise<ServiceResult> {
  const { email, projectChannelId } = opts
  let verifiedGuestId: string | undefined

  if (!projectChannelId) {
    return {
      status: 'skipped',
      message: 'No slack_channel_id on the project — nothing to invite them to.',
    }
  }

  try {
    const user = await lookupByEmail(email.trim().toLowerCase())
    const adminStep = `Admin action required: invite ${email} to Ranger & Fox as a single-channel guest for <#${projectChannelId}>. For an existing guest who needs multiple projects, select multi-channel guest and explicitly assign only their project channels. Then rerun onboarding to verify access. Kit will not send a full-member or Slack Connect invitation.`
    if (!user) return { status: 'failed', message: adminStep }

    const auth = await slackGet('auth.test', {})
    if (!auth.ok || !auth.team_id) throw new Error('Cannot verify the Ranger & Fox workspace')
    const isGuest = (u: SlackGuestUser | undefined) => u?.id === user.id && u.team_id === auth.team_id &&
      u.is_restricted === true && typeof u.is_ultra_restricted === 'boolean' &&
      !u.deleted && !u.is_bot && !u.is_admin && !u.is_owner && !u.is_invited_user
    if (!isGuest(user)) {
      return { status: 'failed', message: `Guest access not verified for <@${user.id}>. No channel invitation sent. An admin must review the existing account and its role. ${adminStep}` }
    }
    verifiedGuestId = user.id

    // Single-channel guests must not be moved from a different project implicitly.
    const membership = async () => {
      let cursor = ''
      for (let page = 0; page < 100; page++) {
        const r = await slackGet('conversations.members', { channel: projectChannelId, limit: '200', ...(cursor ? { cursor } : {}) })
        if (!r.ok || !Array.isArray(r.members)) throw new Error('Cannot verify project-channel membership')
        if (r.members.includes(user.id)) return true
        cursor = r.response_metadata?.next_cursor || ''
        if (!cursor) return false
      }
      throw new Error('Project-channel membership verification exceeded page limit')
    }
    if (!await membership()) {
      if (user.is_ultra_restricted === true) {
        return { status: 'failed', message: `Single-channel guest <@${user.id}> is not assigned to <#${projectChannelId}>. ${adminStep}` }
      }
      await inviteToChannel(projectChannelId, user.id)
    }
    const verified = await slackGet('users.info', { user: user.id })
    if (!verified.ok || !isGuest(verified.user) || !await membership()) {
      throw new Error('Guest role or channel access could not be verified after onboarding; admin review required. Do not assume access is complete.')
    }
    return {
      status: 'ok',
      message: `Verified ${verified.user.is_ultra_restricted ? 'single-channel' : 'multi-channel'} guest <@${user.id}> with access to <#${projectChannelId}>.`,
      slackUserId: user.id,
    }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err), ...(verifiedGuestId ? { slackUserId: verifiedGuestId } : {}) }
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
