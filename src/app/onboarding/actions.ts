'use server'

import { createActionClient } from '@/lib/supabase/server'

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

    const { data, error } = await supabase.rpc('create_workspace' as any, {
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
