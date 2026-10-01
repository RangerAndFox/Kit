import { createAdminClient } from '../../../src/lib/supabase/admin'

export function isReplyOwnershipConflict(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' && !!error.message?.includes('checkin_reply_already_owned')
}

/** Read failures are not permission to remind or write hours. */
export async function checkinActionIsCurrent(id: string, status: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc('checkin_action_is_current', {
    p_checkin_id: id, p_expected_status: status,
  })
  if (error) throw new Error(`check-in ownership unavailable: ${error.message}`)
  return data === true
}
