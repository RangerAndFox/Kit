// @ts-nocheck
/**
 * Slack-activity project inference (Feature #10 extension).
 *
 * Guesses which projects a creative is currently working on from the Slack
 * project channels they belong to. A project channel is linked to a project via
 * projects.external_links.slack_id; we intersect the *live* project channels
 * (status active/partial) with the channels the artist is a member of.
 *
 * Two consumers:
 *   - the daily check-in DM pre-fills these as candidates ("active in #x")
 *   - the missing-time flag names them so a producer knows where to look
 *
 * Membership (not message history) keeps this to a single Slack call per user
 * and avoids per-channel history scans; intersecting with live projects filters
 * out the long tail of stale channels people never leave.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'

export interface ActiveChannel {
  projectId: string
  projectName: string
  channelId: string
  channelName: string
}

/**
 * Pure intersection: live project channels ∩ the user's channel memberships.
 * Exported for tests — no Slack/DB calls.
 */
export function intersectProjectChannels(
  projectChannels: { channelId: string; projectId: string; projectName: string }[],
  memberChannels: { id: string; name?: string }[],
): ActiveChannel[] {
  const memberById = new Map(memberChannels.map((c) => [c.id, c.name || '']))
  const out: ActiveChannel[] = []
  for (const pc of projectChannels) {
    if (memberById.has(pc.channelId)) {
      out.push({
        projectId: pc.projectId,
        projectName: pc.projectName,
        channelId: pc.channelId,
        channelName: memberById.get(pc.channelId) || '',
      })
    }
  }
  return out
}

/**
 * Live project→channel list, cached for a few minutes: the check-in and
 * missing-time crons call inferActiveProjectChannels once PER STAFF MEMBER,
 * which used to re-query every active project from Supabase each time.
 */
const PROJECT_CHANNELS_TTL_MS = 5 * 60 * 1000
let _projectChannels: {
  list: { channelId: string; projectId: string; projectName: string }[]
  at: number
} | null = null

async function loadLiveProjectChannels(): Promise<
  { channelId: string; projectId: string; projectName: string }[]
> {
  if (_projectChannels && Date.now() - _projectChannels.at < PROJECT_CHANNELS_TTL_MS) {
    return _projectChannels.list
  }
  const sb = createAdminClient()
  const { data: projects } = await sb
    .from('projects')
    .select('id, name, status, external_links')
    .in('status', ['active', 'partial'])

  const list = (projects || [])
    .map((p: any) => ({
      channelId: p.external_links?.slack_id as string | undefined,
      projectId: p.id as string,
      projectName: p.name as string,
    }))
    .filter((p) => !!p.channelId) as { channelId: string; projectId: string; projectName: string }[]
  _projectChannels = { list, at: Date.now() }
  return list
}

/**
 * Resolve the live project channels a creative is active in. Never throws —
 * returns [] on any Slack/DB hiccup so callers can treat it as best-effort.
 */
export async function inferActiveProjectChannels(opts: {
  app: App
  slackUserId: string
}): Promise<ActiveChannel[]> {
  const { app, slackUserId } = opts
  try {
    const projectChannels = await loadLiveProjectChannels()
    if (projectChannels.length === 0) return []

    const res = await app.client.users.conversations({
      user: slackUserId,
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
    })
    const memberChannels = (res.channels || []).map((c: any) => ({ id: c.id, name: c.name }))

    return intersectProjectChannels(projectChannels, memberChannels)
  } catch (err: any) {
    console.warn(`[slack-activity] inference failed for ${slackUserId}: ${err?.message || err}`)
    return []
  }
}
