import { z } from 'zod'
import { createAdminClient, ok, fail } from '../helpers'
import type { KitTool } from '../types'

const workspaceId = z.string().uuid()

// ─── kit_list_team ───────────────────────────────────────────

export const listTeam: KitTool = {
  name: 'kit_list_team',
  description:
    'List team members in a workspace. Returns id, name, email, role, permission_tier, hourly_rate, and integration IDs (slack_user_id, clockify_user_id, etc.). Use this to look up who to assign to a project or ping in Slack.',
  schema: z.object({
    workspace_id: workspaceId,
    role: z.string().optional().describe('Filter by role (e.g., "producer", "artist")'),
    active_only: z.boolean().optional().default(true),
  }),
  annotations: { readOnlyHint: true },
  handler: async ({ workspace_id, role, active_only = true }) => {
    const db = createAdminClient()
    let q = db
.from('team_members')
      .select(
        'id, name, email, role, permission_tier, hourly_rate, slack_user_id, clockify_user_id, notion_user_id, frameio_user_id, is_active'
      )
      .eq('workspace_id', workspace_id)
      .order('name', { ascending: true })
    if (role) q = q.eq('role', role)
    if (active_only) q = q.eq('is_active', true)
    const { data, error } = await q
    if (error) return fail(error.message)
    return ok({ count: data?.length || 0, team_members: data || [] })
  },
}

// ─── kit_assign_project_access ───────────────────────────────

export const assignProjectAccess: KitTool = {
  name: 'kit_assign_project_access',
  description:
    'Grant a team member access to a project and define their role on that project. Use after kit_create_project to staff the team. project_role is free-text (e.g., "producer", "lead artist", "director").',
  schema: z.object({
    workspace_id: workspaceId,
    project_id: z.string().uuid(),
    team_member_id: z.string().uuid(),
    project_role: z.string().min(1).describe('Their role on this project'),
    deliverables: z.array(z.string().uuid()).optional().describe('Specific deliverables they own'),
    can_see_financials: z.boolean().optional().default(false),
  }),
  handler: async (input) => {
    const db = createAdminClient()
    const { data, error } = await db
.from('project_access')
      .insert(input)
      .select('*')
      .single()
    if (error) return fail(error.message)
    return ok(data, 'Access granted')
  },
}
