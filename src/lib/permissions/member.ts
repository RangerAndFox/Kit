import type { SupabaseClient } from '@supabase/supabase-js'
import type { TeamRole } from '../../types/database'

export interface WorkspaceMember { id: string; role: TeamRole }

/** Auth UUIDs and member UUIDs are distinct. Caller-supplied roles are not authority. */
export async function resolveWorkspaceMember(db: SupabaseClient, authUserId: string, workspaceId: string): Promise<WorkspaceMember | null> {
  const { data, error } = await db.from('team_members').select('id,role,permission_tier')
    .eq('auth_user_id', authUserId).eq('workspace_id', workspaceId).maybeSingle()
  if (error || !data) return null
  const tier = data.permission_tier || data.role
  const role = tier === 'admin' ? 'founder' : tier
  if (!['founder', 'producer', 'artist', 'freelancer'].includes(role)) return null
  return { id: data.id, role }
}

export async function memberCanAccessProject(db: SupabaseClient, member: WorkspaceMember, workspaceId: string, projectId: string): Promise<boolean> {
  const { data: project, error } = await db.from('projects').select('id').eq('id', projectId).eq('workspace_id', workspaceId).maybeSingle()
  if (error || !project) return false
  if (member.role === 'founder') return true
  const access = await db.from('project_access').select('id').eq('team_member_id', member.id)
    .eq('project_id', projectId).eq('workspace_id', workspaceId).maybeSingle()
  return !access.error && !!access.data
}
