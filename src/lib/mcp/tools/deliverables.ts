import { z } from 'zod'
import { createAdminClient, ok, fail } from '../helpers'
import type { KitTool } from '../types'

const workspaceId = z.string().uuid()
const projectId = z.string().uuid()

// ─── kit_create_deliverables (bulk) ──────────────────────────

export const createDeliverables: KitTool = {
  name: 'kit_create_deliverables',
  description:
    'Create one or more deliverables for a project in a single call. Use bulk insertion when setting up a new project (e.g., "Hero film 60s", "Hero film 30s", "Social cutdowns 15s x3"). Each deliverable needs a name; status defaults to "not_started".',
  schema: z.object({
    workspace_id: workspaceId,
    project_id: projectId,
    deliverables: z
      .array(
        z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          status: z
            .enum(['not_started', 'in_progress', 'in_review', 'delivered', 'approved', 'blocked'])
            .optional(),
          due_date: z.string().optional().describe('ISO date'),
          delivery_url: z.string().optional(),
        })
      )
      .min(1)
      .describe('Array of deliverables to create'),
  }),
  handler: async ({ workspace_id, project_id, deliverables }) => {
    const db = createAdminClient()
    const rows = deliverables.map((d: {
      name: string
      description?: string
      status?: string
      due_date?: string
      delivery_url?: string
    }) => ({ workspace_id, project_id, ...d }))
const { data, error } = await db.from('deliverables').insert(rows).select('*')
    if (error) return fail(error.message)
    return ok({ created: data?.length || 0, deliverables: data }, `Created ${data?.length} deliverables`)
  },
}

// ─── kit_update_deliverable ──────────────────────────────────

export const updateDeliverable: KitTool = {
  name: 'kit_update_deliverable',
  description:
    'Update a deliverable. Common uses: moving status forward, setting delivered_at when shipped, attaching a delivery_url to a Frame.io or Dropbox link.',
  schema: z.object({
    workspace_id: workspaceId,
    deliverable_id: z.string().uuid(),
    name: z.string().optional(),
    status: z
      .enum(['not_started', 'in_progress', 'in_review', 'delivered', 'approved', 'blocked'])
      .optional(),
    due_date: z.string().optional(),
    delivered_at: z.string().optional(),
    delivery_url: z.string().optional(),
    description: z.string().optional(),
  }),
  handler: async (input) => {
    const db = createAdminClient()
    const { workspace_id, deliverable_id, ...fields } = input
    if (Object.keys(fields).length === 0) return fail('No fields to update')
    const { data, error } = await db
.from('deliverables')
      .update(fields)
      .eq('workspace_id', workspace_id)
      .eq('id', deliverable_id)
      .select('*')
      .single()
    if (error) return fail(error.message)
    return ok(data)
  },
}
