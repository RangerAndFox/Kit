import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'

export async function getCurrentUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function getCurrentTeamMember() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: member } = await supabase
.from('team_members')
    .select('*, workspaces(*)')
    .eq('user_id', user.id)
    .single() as any

  return member
}

export async function requireAuth() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return user
}

export async function getWorkspaceId(): Promise<string | null> {
  const member = await getCurrentTeamMember()
  return member?.workspace_id ?? null
}
