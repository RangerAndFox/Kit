'use server'

import { createClient } from '@/lib/supabase/server'
import { authRedirectBaseUrl } from '@/lib/auth/redirect-url'
import { redirect } from 'next/navigation'

export async function signInWithMagicLink(formData: FormData) {
  const supabase = await createClient()
  const email = formData.get('email') as string

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${authRedirectBaseUrl()}/auth/callback`,
    },
  })

  if (error) {
    return { error: error.message }
  }
  return { success: true }
}

export async function signInWithGoogle() {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${authRedirectBaseUrl()}/auth/callback`,
    },
  })

  if (error) {
    return { error: error.message }
  }

  if (data.url) {
    redirect(data.url)
  }
}
