// @ts-nocheck
/**
 * Conversational role management — lets an admin set/check Kit access tiers
 * by talking to Kit ("make @Allyson a producer") instead of the /kit role
 * slash command (which Slack doesn't offer inside the Assistant/DM pane).
 *
 * Admin-gated. If the caller isn't an admin, this returns false (not
 * handled) so the message falls through to the orchestrator rather than
 * showing a confusing denial for an ambiguous phrase.
 */

import type { App } from '@slack/bolt'
import { parseRoleIntent } from './keyword'
import {
  resolveUserContext,
  failsafeArtistContext,
  setTeamMemberRole,
  getTeamMemberRole,
  normalizeRoleInput,
  tierLabelForRole,
} from '../../../src/lib/inngest/access-control'

async function callerEmail(app: App, slackUserId: string): Promise<string | undefined> {
  try {
    const info = await app.client.users.info({ user: slackUserId })
    return info.user?.profile?.email || undefined
  } catch {
    return undefined
  }
}

export async function handleRoleMessage(opts: {
  app: App
  channelId: string
  userId: string
  text: string
  threadTs?: string
}): Promise<boolean> {
  const intent = parseRoleIntent(opts.text)
  if (!intent) return false

  const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
  if (!workspaceId) return false

  // Resolve the caller WITH email so the founder override applies even when
  // team_members is empty.
  const email = await callerEmail(opts.app, opts.userId)
  const caller =
    (await resolveUserContext(workspaceId, opts.userId, email)) ??
    failsafeArtistContext(workspaceId, opts.userId)

  // Only admins manage roles. Non-admins: don't hijack the message — let the
  // orchestrator handle it (it'll explain that roles are admin-managed).
  if (caller.tier !== 'admin') return false

  const post = (text: string) =>
    opts.app.client.chat.postMessage({
      channel: opts.channelId,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      text,
    })

  // Query: "what's @Allyson's role"
  if (intent.isQuery) {
    const current = await getTeamMemberRole(workspaceId, intent.targetSlackId)
    if (!current) {
      await post(
        `<@${intent.targetSlackId}> isn't in the staff directory yet — they default to *artist* tier. Say "make <@${intent.targetSlackId}> a producer" to set a role.`,
      )
    } else {
      await post(`<@${intent.targetSlackId}> is currently *${tierLabelForRole(current.role)}* in Kit.`)
    }
    return true
  }

  // Set
  const role = normalizeRoleInput(intent.role || '')
  if (!role) {
    await post(
      `I can set *producer*, *artist*, *admin*, or *freelancer*. Which one for <@${intent.targetSlackId}>?`,
    )
    return true
  }

  try {
    await setTeamMemberRole(workspaceId, intent.targetSlackId, role)
    await post(`:white_check_mark: Set <@${intent.targetSlackId}> to *${tierLabelForRole(role)}* in Kit.`)
  } catch (err: any) {
    await post(`Couldn't set that role: ${err?.message || 'unknown error'}`)
  }
  return true
}
