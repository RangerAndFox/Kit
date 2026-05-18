// @ts-nocheck
/**
 * Onboarding permission check: only producers, creative directors, and
 * admins can onboard freelancers. Returns true if the requester is allowed.
 */

import { createAdminClient } from '../../../src/lib/supabase/admin'

const ALLOWED_ROLES = ['producer', 'cd', 'admin']

export async function canOnboard(slackUserId: string): Promise<boolean> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('staff')
    .select('role, is_active')
    .eq('slack_user_id', slackUserId)
    .maybeSingle()
  if (!data || !data.is_active) return false
  return ALLOWED_ROLES.includes(data.role)
}
