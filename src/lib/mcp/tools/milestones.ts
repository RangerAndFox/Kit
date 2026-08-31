import { z } from 'zod'
import { createAdminClient, ok, fail } from '../helpers'
import type { KitTool } from '../types'

const workspaceId = z.string().uuid()
const projectId = z.string().uuid()

// ─── kit_create_milestones (bulk) ────────────────────────────

export const createMilestones: KitTool = {
  name: 'kit_create_milestones',
  description:
    'Create one or more milestones for a project. Milestones are timeline markers (e.g., "Concept approval", "Shoot date", "V1 delivery"). Each needs a name and due_date. phase_type tags what stage of production it falls in.',
  schema: z.object({
    workspace_id: workspaceId,
    project_id: projectId,
    milestones: z
      .array(
        z.object({
          name: z.string().min(1),
          due_date: z.string().describe('ISO date'),
          phase_type: z
            .enum([
              'pre_production',
              'production',
              'post_production',
              'delivery',
              'review',
              'approval',
              'other',
            ])
            .optional(),
          description: z.string().optional(),
          owner: z.string().optional().describe('Free-text owner label'),
          assigned_to: z.string().uuid().optional().describe('team_member.id'),
          dependencies: z.array(z.string().uuid()).optional().describe('milestone.ids this depends on'),
          status: z
            .enum(['upcoming', 'in_progress', 'completed', 'at_risk', 'blocked', 'cancelled'])
            .optional(),
        })
      )
      .min(1),
  }),
  handler: async ({ workspace_id, project_id, milestones }) => {
    const db = createAdminClient()
    const rows = milestones.map((m: {
      name: string
      due_date: string
      phase_type?: string
      description?: string
      owner?: string
      assigned_to?: string
      dependencies?: string[]
      status?: string
    }) => ({ workspace_id, project_id, ...m }))
const { data, error } = await db.from('milestones').insert(rows).select('*')
    if (error) return fail(error.message)
    return ok({ created: data?.length || 0, milestones: data }, `Created ${data?.length} milestones`)
  },
}

// ─── kit_update_milestone ────────────────────────────────────

export const updateMilestone: KitTool = {
  name: 'kit_update_milestone',
  description:
    'Update a milestone. Common uses: marking status completed and setting completed_at when done; flipping to at_risk when slipping; reassigning owner.',
  schema: z.object({
    workspace_id: workspaceId,
    milestone_id: z.string().uuid(),
    name: z.string().optional(),
    status: z
      .enum(['upcoming', 'in_progress', 'completed', 'at_risk', 'blocked', 'cancelled'])
      .optional(),
    due_date: z.string().optional(),
    completed_at: z.string().optional(),
    owner: z.string().optional(),
    assigned_to: z.string().uuid().optional(),
    phase_type: z
      .enum([
        'pre_production',
        'production',
        'post_production',
        'delivery',
        'review',
        'approval',
        'other',
      ])
      .optional(),
  }),
  handler: async (input) => {
    const db = createAdminClient()
    const { workspace_id, milestone_id, ...fields } = input
    if (Object.keys(fields).length === 0) return fail('No fields to update')
    const { data, error } = await db
.from('milestones')
      .update(fields)
      .eq('workspace_id', workspace_id)
      .eq('id', milestone_id)
      .select('*')
      .single()
    if (error) return fail(error.message)
    return ok(data)
  },
}
