import type { App } from '@slack/bolt'
import type { Block, KnownBlock, View } from '@slack/types'
import type { Json } from '../../../src/types/supabase'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { resolveUserContext } from '../../../src/lib/inngest/access-control'
import { projectNumberFromCode } from '../../../src/lib/studio-knowledge/project-sync'
import {
  createProjectDeletionRequest,
  getProjectDeletionRequest,
} from '../../../src/lib/project-deletion/store'
import {
  createProjectDeletionAdapters,
  runProjectDeletion,
} from '../../../src/lib/project-deletion/workflow'
import {
  deletionConfirmationText,
  type ProjectDeletionSnapshot,
} from '../../../src/lib/project-deletion/types'

type SlackClient = App['client']
type ProjectRow = { id: string; name?: string | null; client?: string | null; project_code?: string | null }
type ActionBodyShape = {
  user: { id: string }
  team?: { id?: string }
  trigger_id: string
  channel?: { id?: string }
  message?: { ts?: string }
}
type SelectActionShape = { selected_option: { value: string }; value?: string }
type ConfirmationMetadata = { projectId: string; workspaceId: string; expected: string }

const db = () => createAdminClient()

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jsonObject(value: Json | null | undefined): Record<string, Json | undefined> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function jsonString(record: Record<string, Json | undefined>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

async function resolveWorkspaceId(teamId: string): Promise<string> {
  if (teamId) {
    const { data } = await db().from('workspaces').select('id').eq('slack_team_id', teamId).limit(1).maybeSingle()
    if (data?.id) return data.id
  }
  if (process.env.KIT_DEFAULT_WORKSPACE_ID) return process.env.KIT_DEFAULT_WORKSPACE_ID
  const { data } = await db().from('workspaces').select('id').limit(1).maybeSingle()
  return data?.id || ''
}

async function requireAdmin(client: SlackClient, workspaceId: string, userId: string): Promise<void> {
  let email: string | undefined
  try { email = (await client.users.info({ user: userId }))?.user?.profile?.email || undefined } catch {}
  const context = await resolveUserContext(workspaceId, userId, email)
  if (context?.tier !== 'admin') throw new Error('Project deletion is founder/admin only.')
}

const projectLabel = (row: ProjectRow) => [projectNumberFromCode(row.project_code), row.client, row.name]
  .filter(Boolean).join(' — ').slice(0, 75)

async function listProjects(workspaceId: string): Promise<ProjectRow[]> {
  const { data, error } = await db().from('projects')
    .select('id,name,client,project_code,status,created_at')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(`Could not load projects: ${error.message}`)
  return (data || []) as ProjectRow[]
}

export async function buildProjectDeletionCardForContext(input: {
  teamId: string
  userId: string
  client: SlackClient
}): Promise<{ text: string; blocks: Array<KnownBlock | Block> }> {
  const workspaceId = await resolveWorkspaceId(input.teamId)
  if (!workspaceId) throw new Error('Kit workspace is not configured.')
  await requireAdmin(input.client, workspaceId, input.userId)
  const projects = await listProjects(workspaceId)
  if (projects.length === 0) {
    return {
      text: 'There are no Kit projects to delete.',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: ':white_check_mark: There are no Kit projects to delete.' } }],
    }
  }
  return {
    text: 'Delete a Kit project everywhere.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Delete project everywhere*\nFounder/admin only. Kit will inventory the exact linked outputs before anything is removed.',
        },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Choose the project to inspect:' },
        accessory: {
          type: 'static_select',
          action_id: 'kit_project_delete_select',
          placeholder: { type: 'plain_text', text: 'Select a project' },
          options: projects.map((row) => ({
            text: { type: 'plain_text', text: projectLabel(row) || row.id, emoji: true },
            value: row.id,
          })),
        },
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: '_Nothing is deleted until you review the inventory and type the project-specific confirmation._',
        }],
      },
    ],
  }
}

async function loadSnapshot(projectId: string, workspaceId: string): Promise<ProjectDeletionSnapshot> {
  const [{ data: project, error }, { data: canvases }, { data: binding }, { data: archiveJobs }] = await Promise.all([
    db().from('projects').select('id,workspace_id,name,client,project_code,slack_channel_id,harvest_project_id,external_ids,external_links')
      .eq('id', projectId).eq('workspace_id', workspaceId).maybeSingle(),
    db().from('project_control_canvases').select('canvas_id').eq('project_id', projectId),
    db().from('project_control_bindings').select('canvas_id').eq('project_id', projectId).maybeSingle(),
    db().from('archive_jobs').select('id,results').eq('project_id', projectId).limit(5),
  ])
  if (error || !project) throw new Error(`Could not load project: ${error?.message || 'not found'}`)
  const links = jsonObject(project.external_links)
  const externalIds = jsonObject(project.external_ids)
  const projectNumber = jsonString(links, 'project_number') || jsonString(externalIds, 'project_number') || projectNumberFromCode(project.project_code) || ''
  const canvasIds = [...new Set([
    ...(canvases || []).map((row: { canvas_id?: string | null }) => row.canvas_id),
    binding?.canvas_id,
  ].filter(Boolean))] as string[]
  const retainedLinks = ['figma', 'wordpress', 'vimeo', 'buffer', 'behance']
    .filter((key) => Boolean(jsonString(links, key)))
    .map((key) => `${key}: ${jsonString(links, key)}`)
  if ((archiveJobs || []).some((job) => Object.keys(jsonObject(job.results)).length > 0)) {
    retainedLinks.push('Existing archive/portfolio drafts or published outputs (retained for safety)')
  }
  return {
    projectId: project.id,
    workspaceId: project.workspace_id,
    projectNumber: String(projectNumber),
    client: project.client || '',
    projectName: project.name || '',
    slackChannelId: project.slack_channel_id || jsonString(links, 'slack_id') || jsonString(links, 'slack_channel_id'),
    canvasIds,
    dropboxPath: jsonString(links, 'dropbox_id') || jsonString(links, 'dropbox_path'),
    frameioProjectId: jsonString(links, 'frameio_id') || jsonString(links, 'frameio_project_id'),
    harvestProjectId: Number(jsonString(links, 'harvest_id') || jsonString(links, 'harvest_project_id') || project.harvest_project_id) || undefined,
    boordsStoryboardId: jsonString(links, 'boords_id') || jsonString(links, 'boords_storyboard_id'),
    hasSheetBinding: Boolean(binding),
    retainedLinks,
  }
}

function inventoryLines(snapshot: ProjectDeletionSnapshot): string[] {
  return [
    snapshot.dropboxPath && `• Dropbox folder: \`${snapshot.dropboxPath}\``,
    snapshot.frameioProjectId && `• Frame.io project: \`${snapshot.frameioProjectId}\``,
    snapshot.harvestProjectId && `• Harvest project: \`${snapshot.harvestProjectId}\` *(its time entries and expenses are also deleted)*`,
    snapshot.boordsStoryboardId && `• Boords storyboard: \`${snapshot.boordsStoryboardId}\``,
    snapshot.canvasIds.length && `• Slack canvases: ${snapshot.canvasIds.length}`,
    snapshot.hasSheetBinding && '• Google Sheet project row and all normalized child rows',
    snapshot.slackChannelId && `• Slack channel: \`${snapshot.slackChannelId}\` *(renamed and archived; Slack has no hard-delete API)*`,
    '• Kit project, workback/share events, and internal linked records',
  ].filter(Boolean).map(String)
}

function buildConfirmationModal(snapshot: ProjectDeletionSnapshot): View {
  const expected = deletionConfirmationText(snapshot.projectNumber || snapshot.projectId.slice(0, 8))
  const retained = snapshot.retainedLinks.length
    ? `\n\n:warning: *Retained because Kit cannot prove ownership:*\n${snapshot.retainedLinks.map((link) => `• ${link}`).join('\n')}`
    : ''
  return {
    type: 'modal',
    callback_id: 'kit_project_delete_confirm',
    title: { type: 'plain_text', text: 'Delete project' },
    submit: { type: 'plain_text', text: 'Delete everywhere' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify({ projectId: snapshot.projectId, workspaceId: snapshot.workspaceId, expected }),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *Permanent deletion: ${snapshot.projectNumber} — ${snapshot.client} — ${snapshot.projectName}*\n\n${inventoryLines(snapshot).join('\n')}${retained}`,
        },
      },
      {
        type: 'input',
        block_id: 'confirmation',
        label: { type: 'plain_text', text: `Type ${expected} to confirm` },
        element: { type: 'plain_text_input', action_id: 'value', placeholder: { type: 'plain_text', text: expected } },
      },
    ],
  }
}

async function postOutcome(client: SlackClient, channel: string, ts: string, requestId: string): Promise<void> {
  const request = await getProjectDeletionRequest(requestId)
  if (!request) return
  const complete = request.status === 'complete'
  const blocks: Array<KnownBlock | Block> = [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: complete
        ? `:white_check_mark: *${request.project_snapshot.projectNumber} — ${request.project_snapshot.projectName} deleted everywhere Kit owns.*\nThe Slack channel was archived. The deletion audit remains in Kit.`
        : `:warning: *Deletion paused safely.*\n${request.error || 'One or more providers failed.'}\n\nKit kept the core project record so the exact failed steps can be retried.`,
    },
  }]
  if (!complete) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Retry failed steps' }, action_id: 'kit_project_delete_retry', value: requestId }],
    })
  }
  await client.chat.update({
    channel,
    ts,
    text: complete ? 'Project deletion complete.' : 'Project deletion needs attention.',
    blocks,
  })
}

export function registerProjectDeletionHandlers(app: App): void {
  app.action('kit_project_delete_select', async ({ ack, body, action, client }) => {
    await ack()
    const actionBody = body as unknown as ActionBodyShape
    const selectAction = action as unknown as SelectActionShape
    const userId = actionBody.user.id
    const workspaceId = await resolveWorkspaceId(actionBody.team?.id || '')
    try {
      await requireAdmin(client, workspaceId, userId)
      const snapshot = await loadSnapshot(selectAction.selected_option.value, workspaceId)
      await client.views.open({ trigger_id: actionBody.trigger_id, view: buildConfirmationModal(snapshot) })
    } catch (error: unknown) {
      if (actionBody.channel?.id) {
        await client.chat.postEphemeral({ channel: actionBody.channel.id, user: userId, text: `Could not open project deletion: ${errorText(error)}` }).catch(() => {})
      }
    }
  })

  app.view('kit_project_delete_confirm', async ({ ack, body, view, client }) => {
    const metadata = JSON.parse(view.private_metadata || '{}') as ConfirmationMetadata
    const values = view.state.values as unknown as { confirmation?: { value?: { value?: string } } }
    const entered = values.confirmation?.value?.value?.trim()
    if (entered !== metadata.expected) {
      await ack({ response_action: 'errors', errors: { confirmation: `Type exactly: ${metadata.expected}` } })
      return
    }
    let acknowledged = false
    try {
      await requireAdmin(client, metadata.workspaceId, body.user.id)
      const snapshot = await loadSnapshot(metadata.projectId, metadata.workspaceId)
      // Recompute the confirmation target from the fresh row so a stale modal
      // cannot delete a project whose identifying number changed meanwhile.
      const freshExpected = deletionConfirmationText(snapshot.projectNumber || snapshot.projectId.slice(0, 8))
      if (freshExpected !== metadata.expected) {
        await ack({ response_action: 'errors', errors: { confirmation: `Project changed. Close and reopen deletion, then type ${freshExpected}.` } })
        return
      }
      const request = await createProjectDeletionRequest({
        snapshot,
        requestedBySlackUserId: body.user.id,
        idempotencyKey: `slack-view:${view.id}`,
      })
      await ack()
      acknowledged = true
      const dm = await client.conversations.open({ users: body.user.id })
      const channel = dm.channel?.id
      if (!channel) throw new Error('Slack did not open the private deletion DM.')
      const message = await client.chat.postMessage({
        channel,
        text: `Deleting ${snapshot.projectNumber} everywhere…`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:hourglass_flowing_sand: *Deleting ${snapshot.projectNumber} — ${snapshot.projectName}*\nExternal outputs first; Kit’s project record last.` } }],
      })
      void runProjectDeletion(request.id, createProjectDeletionAdapters(client))
        .catch((error) => console.error('[project-delete]', error))
        .finally(() => postOutcome(client, channel, message.ts!, request.id).catch((error) => console.error('[project-delete] outcome', error)))
    } catch (error: unknown) {
      if (!acknowledged) {
        await ack({ response_action: 'errors', errors: { confirmation: errorText(error) } })
      } else {
        console.error('[project-delete] start', error)
      }
    }
  })

  app.action('kit_project_delete_retry', async ({ ack, body, action, client }) => {
    await ack()
    const actionBody = body as unknown as ActionBodyShape
    const selectAction = action as unknown as SelectActionShape
    const request = await getProjectDeletionRequest(selectAction.value || '')
    if (!request) return
    try {
      await requireAdmin(client, request.workspace_id, actionBody.user.id)
      await runProjectDeletion(request.id, createProjectDeletionAdapters(client))
      if (actionBody.channel?.id && actionBody.message?.ts) {
        await postOutcome(client, actionBody.channel.id, actionBody.message.ts, request.id)
      }
    } catch (error: unknown) {
      console.error('[project-delete] retry', error)
    }
  })
}
