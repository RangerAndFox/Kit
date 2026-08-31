import { z } from 'zod'
import { createAdminClient, ok, fail } from '../helpers'
import type { KitTool } from '../types'

const workspaceId = z.string().uuid()

// ─── kit_upsert_client_profile ───────────────────────────────

export const upsertClientProfile: KitTool = {
  name: 'kit_upsert_client_profile',
  description:
    'Create or update a client profile. Use this to record relationship signals that help Kit write smarter emails and action items — payment reliability, scope creep tendency, primary contacts, and health trend. If a profile with the same client_name already exists in the workspace, it gets updated.',
  schema: z.object({
    workspace_id: workspaceId,
    client_name: z.string().min(1),
    primary_contacts: z
      .array(
        z.object({
          name: z.string(),
          email: z.string().optional(),
          role: z.string().optional(),
        })
      )
      .optional(),
    health_score: z.number().min(0).max(100).optional(),
    health_trend: z.enum(['improving', 'stable', 'declining']).optional(),
    payment_reliability: z.enum(['excellent', 'good', 'fair', 'poor']).optional(),
    scope_creep_tendency: z.enum(['low', 'medium', 'high']).optional(),
  }),
  handler: async (input) => {
    const db = createAdminClient()
    const { workspace_id, client_name, ...rest } = input

    // Try to find existing
    const { data: existing } = await db
.from('client_profiles')
      .select('id')
      .eq('workspace_id', workspace_id)
      .eq('client_name', client_name)
      .maybeSingle()

    if (existing?.id) {
      const { data, error } = await db
.from('client_profiles')
        .update(rest)
        .eq('id', existing.id)
        .select('*')
        .single()
      if (error) return fail(error.message)
      return ok(data, `Updated client profile for ${client_name}`)
    }

    const { data, error } = await db
.from('client_profiles')
      .insert({ workspace_id, client_name, ...rest })
      .select('*')
      .single()
    if (error) return fail(error.message)
    return ok(data, `Created client profile for ${client_name}`)
  },
}

// ─── kit_get_client_profile ──────────────────────────────────

export const getClientProfile: KitTool = {
  name: 'kit_get_client_profile',
  description:
    'Fetch a client profile by name to inform how to handle a project (e.g., scope-creep tendency, payment reliability). Returns null if no profile exists yet.',
  schema: z.object({
    workspace_id: workspaceId,
    client_name: z.string().min(1),
  }),
  annotations: { readOnlyHint: true },
  handler: async ({ workspace_id, client_name }) => {
    const db = createAdminClient()
    const { data, error } = await db
.from('client_profiles')
      .select('*')
      .eq('workspace_id', workspace_id)
      .eq('client_name', client_name)
      .maybeSingle()
    if (error) return fail(error.message)
    return ok(data || null, data ? `Client profile for ${client_name}:` : `No profile exists for ${client_name} yet.`)
  },
}
