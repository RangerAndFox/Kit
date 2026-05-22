// @ts-nocheck
import { z } from 'zod'
import { createAdminClient, ok, fail } from '../helpers'
import type { KitTool } from '../types'

const workspaceId = z.string().uuid()

// ─── kit_create_action ───────────────────────────────────────

export const createAction: KitTool = {
  name: 'kit_create_action',
  description:
    'Create a kit_action — a tracked, approvable task that Kit wants a human to review or execute. Use this whenever you want to surface something that needs attention (budget alert, scope concern, draft client email, reminder for a producer). requires_approval defaults to true; set to false only for informational notices.',
  schema: z.object({
    workspace_id: workspaceId,
    action_type: z
      .enum([
        'budget_alert',
        'schedule_alert',
        'scope_concern',
        'draft_email',
        'draft_message',
        'follow_up',
        'approval_request',
        'reminder',
        'milestone_reminder',
        'feedback_summary',
        'client_update',
        'other',
      ])
      .describe('Category of action'),
    title: z.string().min(1),
    body: z.string().min(1).describe('Markdown body with details / draft content'),
    project_id: z.string().uuid().optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().default('normal'),
    target_audience: z
      .array(z.string().uuid())
      .optional()
      .describe('team_member.ids to route this to'),
    channel: z
      .enum(['slack', 'email', 'in_app', 'teams'])
      .optional()
      .describe('Where this should be delivered'),
    requires_approval: z.boolean().optional().default(true),
    min_tier_to_view: z.enum(['artist', 'producer', 'lead', 'owner']).optional().default('producer'),
  }),
  handler: async (input) => {
    const db = createAdminClient()
    const { data, error } = await db
      .from('kit_actions' as any)
      .insert(input)
      .select('*')
      .single()
    if (error) return fail(error.message)
    return ok(data, `Created action: ${data.title}`)
  },
}

// ─── kit_list_pending_actions ────────────────────────────────

export const listPendingActions: KitTool = {
  name: 'kit_list_pending_actions',
  description:
    'List kit_actions that are currently pending approval or action. Use this to give a producer a daily digest or a Slack summary.',
  schema: z.object({
    workspace_id: workspaceId,
    project_id: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(100).optional().default(25),
  }),
  annotations: { readOnlyHint: true },
  handler: async ({ workspace_id, project_id, limit = 25 }) => {
    const db = createAdminClient()
    let q = db
      .from('kit_actions' as any)
      .select('id, action_type, title, body, priority, project_id, channel, requires_approval, status, created_at')
      .eq('workspace_id', workspace_id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (project_id) q = q.eq('project_id', project_id)
    const { data, error } = await q
    if (error) return fail(error.message)
    return ok({ count: data?.length || 0, actions: data || [] })
  },
}

// ─── kit_create_action_breakdown ─────────────────────────────

export const createActionBreakdown: KitTool = {
  name: 'kit_create_action_breakdown',
  description:
    'Save the full analysis Kit produced from a kickoff call or major scope-change discussion. This is the canonical record of "what we agreed to, who owns what, what we\'re worried about" that drives subsequent project setup. assignments is a structured jsonb payload; scope_concerns and open_questions are arrays for downstream actions.',
  schema: z.object({
    workspace_id: workspaceId,
    project_id: z.string().uuid(),
    assignments: z.record(z.any()).describe('Structured assignments — e.g., { "producer": [...], "director": [...], "tasks": [...] }'),
    transcript_source: z.string().optional().describe('URL or ID of source transcript (Plaud, Otter, etc.)'),
    call_date: z.string().optional().describe('ISO date of the call'),
    call_summary: z.string().optional().describe('Short prose summary'),
    scope_concerns: z
      .array(z.object({ concern: z.string(), severity: z.enum(['low', 'medium', 'high']).optional() }))
      .optional(),
    open_questions: z
      .array(z.object({ question: z.string(), owner: z.string().optional() }))
      .optional(),
    draft_client_email: z.string().optional().describe('Suggested follow-up email to the client'),
    status: z.enum(['draft', 'approved', 'distributed']).optional().default('draft'),
  }),
  handler: async (input) => {
    const db = createAdminClient()
    const { data, error } = await db
      .from('action_breakdowns' as any)
      .insert(input)
      .select('*')
      .single()
    if (error) return fail(error.message)
    return ok(data, 'Action breakdown saved')
  },
}
