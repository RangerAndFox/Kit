import type { App, BlockAction, ButtonAction } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { inngest } from '../../../src/lib/inngest/client'
import { projectCodeMatches } from '../../../src/lib/project-control/project-identity'
import { workbookConfigFromEnv, projectControlSyncEnabled } from '../../../src/lib/project-control/types'
import { commandActor } from './natural-commands'

export interface RefreshProject {
  id: string; project_code: string | null; slack_channel_id: string | null
  external_links: Record<string, string> | null
}

export function selectRefreshProject(projects: RefreshProject[], channel: string, code: string, projectId?: string): RefreshProject {
  const matches = projects.filter(project => projectId ? project.id === projectId : code
    ? projectCodeMatches(project.project_code, code)
    : [project.slack_channel_id, project.external_links?.slack_id, project.external_links?.slack_channel_id].includes(channel))
  if (matches.length !== 1) throw new Error('Specify one connected project, for example `/kit refresh 2645`, or use its project channel.')
  return matches[0]
}

/** Socket-Mode verified actor -> current role -> workspace/project binding ->
 * durable request. Neither model arguments nor button values confer access. */
export async function requestSlackProjectRefresh(client: WebClient, input: {
  userId: string; teamId: string; channelId: string; code?: string; projectId?: string
}): Promise<string> {
  const { user } = await commandActor(client, input.userId, input.teamId)
  if (!['admin', 'producer'].includes(user.tier)) throw new Error('Only producers and admins can refresh project tabs.')
  const config = workbookConfigFromEnv()
  if (!config || !projectControlSyncEnabled()) throw new Error('Project synchronization is not configured or is paused. Nothing was queued.')
  const db = createAdminClient() as unknown as SupabaseClient
  const bound = await db.from('project_control_bindings').select('project_id,refresh_channel_id')
    .eq('spreadsheet_id', config.spreadsheetId).eq('creation_state', 'connected')
  if (bound.error || !bound.data?.length) throw new Error('Connected project bindings are unavailable. Nothing was queued.')
  const found = await db.from('projects').select('id,project_code,slack_channel_id,external_links')
    .eq('workspace_id', user.workspaceId).in('id', bound.data.map(row => row.project_id))
  if (found.error) throw new Error('Project lookup is unavailable. Nothing was queued.')
  const project = selectRefreshProject(found.data as RefreshProject[], input.channelId, input.code?.trim() || '', input.projectId)
  if (input.projectId && bound.data.find(row => row.project_id === project.id)?.refresh_channel_id !== input.channelId) {
    throw new Error('Use the refresh control in the original project channel.')
  }
  const dm = await client.conversations.open({ users: input.userId })
  if (!dm.ok || !dm.channel?.id?.startsWith('D')) throw new Error('Your private Kit DM could not be opened. Nothing was queued.')
  const queued = await db.rpc('enqueue_slack_project_refresh', {
    p_workspace_id: user.workspaceId, p_project_id: project.id, p_actor: input.userId, p_dm_channel: dm.channel.id,
  })
  if (queued.error || !queued.data) throw new Error('The refresh request could not be saved. Please try again.')
  // The durable outbox cron is the fallback if an immediate wake-up fails.
  if (process.env.INNGEST_EVENT_KEY) {
    try { await inngest.send({ name: 'project-control/refresh.requested', data: { request_id: queued.data } }) }
    catch { /* queued, not lost; the once-per-minute drain owns recovery */ }
  }
  return 'Refresh queued for ' + project.project_code + '. Kit will DM you after the generated tabs finish updating. Repeated clicks reuse the pending request; this is not a completion confirmation yet.'
}

export function registerProjectRefreshHandlers(app: App): void {
  app.action<BlockAction<ButtonAction>>('kit_project_sync_now', async ({ ack, body, client }) => {
    await ack()
    if (!body.user?.id || !body.channel?.id) return
    let text: string
    try {
      text = await requestSlackProjectRefresh(client, { userId: body.user.id, teamId: body.team?.id || '',
        channelId: body.channel.id, projectId: body.actions[0]?.value })
    } catch (error) {
      // Only local, curated errors reach shared surfaces (ephemeral to actor).
      text = error instanceof Error && /^(Only producers|Project synchronization|Connected project|Project lookup|Specify one|Use the refresh|Your private|The refresh request)/.test(error.message)
        ? error.message : 'Kit could not safely request this refresh. Check your access and try again.'
    }
    await client.chat.postEphemeral({ channel: body.channel.id, user: body.user.id, text })
  })
}
