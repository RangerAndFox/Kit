import { z } from 'zod'
import { createAdminClient, ok, fail } from '../helpers'
import type { KitTool } from '../types'

const workspaceId = z.string().uuid()

// ─── kit_save_workback_schedule ──────────────────────────────

export const saveWorkbackSchedule: KitTool = {
  name: 'kit_save_workback_schedule',
  description:
    'Save a workback schedule for a project — the reverse-engineered timeline from delivery date back to today. schedule is a structured jsonb payload with phases and dates; Kit can re-generate this when scope or target_delivery changes. Setting is_active=true auto-deactivates any previous schedules for the project.',
  schema: z.object({
    workspace_id: workspaceId,
    project_id: z.string().uuid(),
    schedule: z.record(z.any()).describe('Structured schedule payload (phases, tasks, dates)'),
    version: z.number().int().optional().default(1),
    is_active: z.boolean().optional().default(true),
    confidence_score: z.number().min(0).max(1).optional(),
    confidence_notes: z.string().optional(),
    risks: z
      .array(z.object({ risk: z.string(), severity: z.enum(['low', 'medium', 'high']).optional() }))
      .optional(),
    open_questions: z
      .array(z.object({ question: z.string(), blocks: z.string().optional() }))
      .optional(),
  }),
  handler: async (input) => {
    const db = createAdminClient()
    const { workspace_id, project_id, is_active } = input

    if (is_active) {
      // Deactivate previous schedules
      await db
        .from('workback_schedules' as any)
        .update({ is_active: false })
        .eq('workspace_id', workspace_id)
        .eq('project_id', project_id)
    }

    const { data, error } = await db
      .from('workback_schedules' as any)
      .insert(input)
      .select('*')
      .single()
    if (error) return fail(error.message)
    return ok(data, 'Workback schedule saved')
  },
}
