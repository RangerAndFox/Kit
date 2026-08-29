import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export interface ControlCenterAccess {
  userId: string
  workspaceId: string
  workspaceName: string
  role: string
  displayName: string
}

interface MemberRecord {
  workspace_id: string
  role: string
  permission_tier: string | null
  name: string | null
  email: string | null
}

export async function getControlCenterAccess(): Promise<ControlCenterAccess | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  // Founder records predate web authentication and may not have auth_user_id
  // populated. `getUser()` gives us a server-verified email, so a service-role
  // lookup by that exact address is a safe compatibility bridge. Never use
  // user_metadata for this authorization decision.
  const admin = createAdminClient()
  let { data: member } = (await admin
    .from('team_members')
    .select('workspace_id, role, permission_tier, name, email')
    .eq('auth_user_id', user.id)
    .maybeSingle()) as unknown as { data: MemberRecord | null }

  if (!member && user.email) {
    const result = (await admin
      .from('team_members')
      .select('workspace_id, role, permission_tier, name, email')
      .eq('email', user.email.toLowerCase())
      .maybeSingle()) as unknown as { data: MemberRecord | null }
    member = result.data
  }

  if (!member || !['founder', 'admin'].includes(member.permission_tier || member.role)) return null

  const { data: workspace } = (await admin
    .from('workspaces')
    .select('name')
    .eq('id', member.workspace_id)
    .maybeSingle()) as unknown as { data: { name: string } | null }

  return {
    userId: user.id,
    workspaceId: member.workspace_id,
    workspaceName: workspace?.name || 'Ranger & Fox',
    role: member.role,
    displayName: member.name || member.email?.split('@')[0] || user.email?.split('@')[0] || 'Founder',
  }
}
