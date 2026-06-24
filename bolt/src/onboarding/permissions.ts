// @ts-nocheck
/**
 * Onboarding permission check: only producers, creative directors, and
 * admins can onboard freelancers. Returns true if the requester is allowed.
 *
 * Source-of-truth note: Kit's role system (the "/kit role @user producer"
 * command and conversational role management) writes to `team_members`, and
 * the rest of Kit gates on the access-control *tier* derived from it
 * (admin/producer/artist). This gate historically only read the separate
 * `staff` table, so anyone made a producer via the role command was still
 * denied onboarding. We now accept EITHER store so the two can't drift:
 *   - team_members tier is admin or producer, OR
 *   - staff.role is an allowed role and the row is active.
 */

import { createAdminClient } from '../../../src/lib/supabase/admin'

const ALLOWED_STAFF_ROLES = ['producer', 'cd', 'admin']
const ALLOWED_TIERS = ['admin', 'producer']

async function staffAllows(slackUserId: string): Promise<boolean> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('staff')
    .select('role, is_active')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()
  if (!data || !data.is_active) return false
  return ALLOWED_STAFF_ROLES.includes(data.role)
}

async function tierAllows(slackUserId: string, email?: string): Promise<boolean> {
  const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
  if (!workspaceId) return false
  try {
    const { resolveUserContext } = await import('../../../src/lib/inngest/access-control')
    const ctx = await resolveUserContext(workspaceId, slackUserId, email)
    if (!ctx) return false
    return ALLOWED_TIERS.includes(ctx.tier)
  } catch (err: any) {
    console.warn(`[onboarding] tierAllows failed: ${err?.message || err}`)
    return false
  }
}

export async function canOnboard(
  slackUserId: string,
  opts: { email?: string } = {},
): Promise<boolean> {
  // Either source of truth can grant access (union, so the two can't drift).
  if (await tierAllows(slackUserId, opts.email)) return true
  if (await staffAllows(slackUserId)) return true
  return false
}
