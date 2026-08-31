import { z } from 'zod'
import { createAdminClient, ok, fail } from '../helpers'
import type { KitTool } from '../types'

const workspaceId = z.string().uuid()

// ─── kit_log_feedback ────────────────────────────────────────

export const logFeedback: KitTool = {
  name: 'kit_log_feedback',
  description:
    'Log a piece of client or stakeholder feedback against a project. Feedback comes from Frame.io comments, email threads, Slack DMs, transcripts, etc. Capturing it here feeds the feedback-health scoring and surfaces patterns.',
  schema: z.object({
    workspace_id: workspaceId,
    project_id: z.string().uuid().optional(),
    source: z.enum(['frameio', 'email', 'slack', 'teams', 'call', 'other']),
    content: z.string().min(1).describe('Raw feedback content'),
    received_at: z.string().describe('ISO timestamp of when the feedback was received'),
    source_id: z.string().optional(),
    source_url: z.string().optional(),
    summary: z.string().optional(),
    sentiment: z.enum(['positive', 'neutral', 'constructive', 'negative', 'mixed']).optional(),
    related_asset: z.string().optional().describe('Asset name or deliverable this refers to'),
    client_contact: z.string().optional(),
    revision_round: z.number().int().optional(),
  }),
  handler: async (input) => {
    const db = createAdminClient()
    const { data, error } = await db
.from('feedback_items')
      .insert({ ...input, status: 'new' })
      .select('*')
      .single()
    if (error) return fail(error.message)
    return ok(data, 'Feedback logged')
  },
}

// ─── kit_log_time_entry ──────────────────────────────────────

export const logTimeEntry: KitTool = {
  name: 'kit_log_time_entry',
  description:
    'Log a time entry against a project. Typically synced from Clockify/Harvest via webhook, but can be called directly. team_member_id is optional — use when the logged hours are for a specific person.',
  schema: z.object({
    workspace_id: workspaceId,
    project_id: z.string().uuid().optional(),
    team_member_id: z.string().uuid().optional(),
    hours: z.number().positive().describe('Number of hours'),
    date: z.string().describe('ISO date'),
    cost: z.number().optional(),
    task_category: z.string().optional(),
    entry_source: z.enum(['integration', 'manual', 'kit_estimate']).optional().default('integration'),
    vendor_name: z.string().optional(),
    external_entry_id: z.string().optional(),
  }),
  handler: async (input) => {
    const db = createAdminClient()
    const { data, error } = await db
.from('time_entries')
      .insert(input)
      .select('*')
      .single()
    if (error) return fail(error.message)
    return ok(data, `Logged ${data.hours}h on ${data.date}`)
  },
}
