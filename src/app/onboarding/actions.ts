'use server'

import { createActionClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function createWorkspace(name: string, slug: string) {
  try {
    const supabase = await createActionClient()

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()

    if (userError || !user) {
      return { success: false, error: 'Not authenticated' }
    }

    const email = user.email
    if (!email) {
      return { success: false, error: 'Your account does not have an email address' }
    }

    const displayName =
      user.user_metadata?.full_name ??
      user.user_metadata?.name ??
      email.split('@')[0]

    // The authenticated client verifies identity; the service client invokes a
    // non-public transaction with that verified immutable user id.
    const admin = createAdminClient()
    const { data, error } = await (admin as any).rpc('create_workspace_service', {
      p_auth_user_id: user.id,
      p_name: name,
      p_slug: slug,
      p_user_name: displayName,
      p_user_email: email,
    } as any)

    if (error) {
      return { success: false, error: error.message }
    }

    return { success: true, workspace: data }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
