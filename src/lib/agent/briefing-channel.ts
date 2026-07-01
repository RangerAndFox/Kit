// @ts-nocheck
/**
 * Per-person briefing channel resolver.
 *
 * Kit posts each pre-meeting briefing in a PRIVATE Slack channel shared only
 * with that one recipient (just them + Kit). Rationale: Kit is a Slack
 * "Agents & AI Apps" assistant, and Slack routes proactive DMs to an
 * assistant's History tab instead of notifying — so recipients missed their
 * prep. A private channel notifies like any message while staying private
 * (no bleeding to anyone who wasn't on the call).
 *
 * The channel is created lazily on the first briefing and its id cached on
 * staff.briefing_channel_id, so we create once and reuse.
 *
 * Required bot scopes: groups:write (create private channels + invite),
 * chat:write (post). Add them in the Slack app config and reinstall.
 */

import { createAdminClient } from '@/lib/supabase/admin'

const SLACK_API = 'https://slack.com/api'

/**
 * Slugify a display name into a Slack-channel-safe fragment: lowercase,
 * only [a-z0-9-], collapsed dashes, trimmed, capped. Pure — unit-tested.
 */
export function slugifyName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Candidate channel names to try, in order. The readable name first, then a
 * name-plus-id-suffix fallback for slug collisions, then a guaranteed-unique
 * id-only name. Slack channel names must be lowercase, <=80 chars, and unique
 * per workspace (even private ones). Pure — unit-tested.
 */
export function briefingChannelNameCandidates(
  fullName: string | null | undefined,
  slackUserId: string,
): string[] {
  const slug = slugifyName(fullName || '')
  const idSuffix = slackUserId.slice(-4).toLowerCase()
  const idFull = slackUserId.toLowerCase()
  const names: string[] = []
  if (slug) {
    names.push(`kit-briefings-${slug}`)
    names.push(`kit-briefings-${slug}-${idSuffix}`)
  }
  // Always end with a guaranteed-unique id-based name.
  names.push(`kit-briefings-${idFull}`)
  // Dedupe while preserving order, cap each at Slack's 80-char limit.
  return [...new Set(names)].map((n) => n.slice(0, 80))
}

async function slackCall(
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  })
  return res.json().catch(() => ({}))
}

/**
 * Find an existing private channel Kit is a member of by exact name, paging
 * through conversations.list. Used to self-heal when a channel already exists
 * (name_taken on create) but its id wasn't cached — e.g. the staff row was
 * recreated. Returns null if not found.
 */
async function findExistingChannelByName(
  token: string,
  names: string[],
): Promise<string | null> {
  const wanted = new Set(names)
  let cursor = ''
  // Bounded paging so a large workspace can't spin forever.
  for (let page = 0; page < 20; page++) {
    const list = await slackCall('conversations.list', token, {
      types: 'private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    if (!list.ok) return null
    for (const ch of list.channels || []) {
      if (wanted.has(ch.name)) return ch.id
    }
    cursor = list.response_metadata?.next_cursor || ''
    if (!cursor) break
  }
  return null
}

/**
 * Resolve (or lazily create) the private 1:1 briefing channel for a staffer,
 * ensure the recipient is a member, and return the channel id.
 *
 * On a cached hit we still re-invite (a no-op if they're already in) so a
 * recipient who left the channel keeps getting briefings.
 */
export async function resolvePersonalBriefingChannel(opts: {
  slackUserId: string
  fullName?: string | null
  token: string
}): Promise<string> {
  const { slackUserId, fullName, token } = opts
  if (!token) throw new Error('SLACK_BOT_TOKEN not set')
  if (!slackUserId) throw new Error('slackUserId required')
  const sb = createAdminClient()

  const { data: staffRow } = await sb
    .from('staff')
    .select('id, briefing_channel_id, full_name')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()

  // 1. Cached channel — reuse it (best-effort re-invite).
  if (staffRow?.briefing_channel_id) {
    await slackCall('conversations.invite', token, {
      channel: staffRow.briefing_channel_id,
      users: slackUserId,
    })
    return staffRow.briefing_channel_id
  }

  // 2. Create a private channel, trying each candidate name until one sticks.
  const candidates = briefingChannelNameCandidates(
    fullName || staffRow?.full_name,
    slackUserId,
  )
  let channelId: string | null = null
  let lastErr = 'unknown'
  for (const name of candidates) {
    const created = await slackCall('conversations.create', token, {
      name,
      is_private: true,
    })
    if (created.ok) {
      channelId = created.channel.id
      break
    }
    lastErr = created.error || 'unknown'
    // name_taken → the channel exists but we may not be in it; try the next
    // (more unique) candidate. Any other error (missing_scope, etc.) is not
    // going to resolve by retrying a different name, so stop.
    if (lastErr !== 'name_taken') break
  }

  // Self-heal: every candidate was name_taken, meaning the channel already
  // exists (cache was lost). Find and reuse it instead of failing.
  if (!channelId && lastErr === 'name_taken') {
    channelId = await findExistingChannelByName(token, candidates)
  }

  if (!channelId) {
    throw new Error(`could not create briefing channel (${lastErr})`)
  }

  // 3. Invite the recipient (creator/bot is already a member).
  const inv = await slackCall('conversations.invite', token, {
    channel: channelId,
    users: slackUserId,
  })
  if (!inv.ok && inv.error !== 'already_in_channel') {
    console.warn(`[briefing-channel] invite ${slackUserId} failed: ${inv.error}`)
  }

  // 4. Cache the channel id so we create only once.
  if (staffRow?.id) {
    await sb
      .from('staff')
      .update({ briefing_channel_id: channelId })
      .eq('id', staffRow.id)
  }
  return channelId
}
