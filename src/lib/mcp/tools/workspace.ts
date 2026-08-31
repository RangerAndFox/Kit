import { z } from 'zod'
import { createAdminClient, ok, fail } from '../helpers'
import type { KitTool } from '../types'

interface WorkspaceContext {
  id: string
  name: string
  slug: string
  plan: string
  slack_team_id: string | null
  settings: unknown
  onboarding_completed: boolean
}

// ─── kit_get_workspace_context ───────────────────────────────

export const getWorkspaceContext: KitTool = {
  name: 'kit_get_workspace_context',
  description:
    'Get the active workspace for a Slack team or user. Use this at the start of any task to look up the workspace_id you need for all subsequent tool calls. If slack_team_id is provided and maps to a workspace, returns it. Otherwise returns the first (default) workspace.',
  schema: z.object({
    workspace_id: z.string().uuid().optional().describe('Workspace scope injected by the authenticated MCP principal'),
    slack_team_id: z.string().optional().describe('Slack team ID from event payload (e.g., T01234ABC)'),
  }),
  annotations: { readOnlyHint: true },
  handler: async ({ workspace_id, slack_team_id }) => {
    const db = createAdminClient()

    if (workspace_id) {
      const { data, error } = await db
.from('workspaces')
        .select('id, name, slug, plan, slack_team_id, settings, onboarding_completed')
        .eq('id', workspace_id)
        .maybeSingle()
      if (error) return fail('Unable to load the authorized workspace.')
      const workspace = data as WorkspaceContext | null
      if (!workspace) return fail('The authorized workspace does not exist.')
      if (slack_team_id && workspace.slack_team_id !== slack_team_id) return fail('Slack team does not match the authorized workspace.')
      return ok(workspace, 'Authorized workspace:')
    }

    if (slack_team_id) {
      const { data } = await db
.from('workspaces')
        .select('id, name, slug, plan, slack_team_id, settings, onboarding_completed')
        .eq('slack_team_id', slack_team_id)
        .limit(1)
        .maybeSingle()
      const workspace = data as WorkspaceContext | null
      if (workspace) return ok(workspace, `Workspace for Slack team ${slack_team_id}:`)
    }

    return fail('A workspace-scoped MCP identity is required.')
  },
}
