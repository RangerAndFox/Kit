import { createHash, randomUUID } from 'node:crypto'
import type { App } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
import { z } from 'zod'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { workbookConfigFromEnv } from '../../../src/lib/project-control/types'
import { readBoundProjectSpecs, writeBoundProjectSpecs } from '../../../src/lib/project-control/sheets'
import { SPEC_HEADERS, specEditSchema, approvedSpecReply, type SpecSnapshot } from '../../../src/lib/project-control/specs'
import { claimWorkbookLease, releaseWorkbookLease, renewWorkbookLease } from '../../../src/lib/project-control/store'
import { commandActor } from './natural-commands'
import { selectRefreshProject, requestSlackProjectRefresh, type RefreshProject } from './project-refresh'
import { saveCommandRequest, claimCommandRequest, finishCommandRequest } from './command-store'

interface SpecContext { userId: string; teamId: string; channelId: string; code?: string }

/** Artists must actually belong to the project channel, even for DM queries.
 * Unknown/partial membership reads deny, never grant access by knowing a code. */
export async function verifySpecMembership(client: WebClient, project: RefreshProject, userId: string): Promise<boolean> {
  const channel = project.slack_channel_id || project.external_links?.slack_id || project.external_links?.slack_channel_id
  if (!channel) return false
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const result = await client.conversations.members({ channel, cursor, limit: 200 })
    if (!result.ok) return false
    if (result.members?.includes(userId)) return true
    cursor = result.response_metadata?.next_cursor || undefined
    if (!cursor) return false
  }
  return false
}

async function resolveSpecs(client: WebClient, input: SpecContext, editing: boolean, projectId?: string) {
  const { user, teamId } = await commandActor(client, input.userId, input.teamId)
  if (editing && user.tier === 'artist') throw new Error('Only a producer, CD or admin can confirm project specs.')
  const config = workbookConfigFromEnv()
  if (!config) throw new Error('Project specs are not configured.')
  const result = await createAdminClient().from('projects').select('id,project_code,slack_channel_id,external_links')
    .eq('workspace_id', user.workspaceId).in('status', ['active', 'on_hold', 'partial'])
  if (result.error) throw new Error('Project lookup is unavailable.')
  const project = selectRefreshProject(result.data as RefreshProject[], input.channelId, input.code || '', projectId)
  const binding = await createAdminClient().from('project_control_bindings').select('project_id')
    .eq('project_id', project.id).eq('spreadsheet_id', config.spreadsheetId).eq('creation_state', 'connected').maybeSingle()
  if (binding.error || !binding.data) throw new Error('This project is not connected to the control sheet.')
  if (user.tier === 'artist' && !await verifySpecMembership(client, project, input.userId)) throw new Error('You need membership in this project’s Slack channel to read its specs.')
  return { user, teamId, project, config }
}

export async function readProjectSpecsReply(client: WebClient, input: SpecContext): Promise<string> {
  const scope = await resolveSpecs(client, input, false)
  return approvedSpecReply(await readBoundProjectSpecs(scope.config, scope.project.id), scope.user.tier === 'artist')
}

const FIELDS = [
  ['dimensions', 'Dimensions (exact width x height)', 1, 32],
  ['frameRate', 'Frame rate (24 is different from 23.976)', 2, 16],
  ['duration', 'Duration', 3, 80],
  ['audio', 'Audio requirements', 4, 160],
  ['fileType', 'Primary file type', 5, 80],
  ['notes', 'Spec notes', 6, 250],
] as const
const metadataSchema = z.object({ projectId: z.string().uuid(), workspaceId: z.string().uuid(), teamId: z.string(), actor: z.string(), source: z.string(), dm: z.string().startsWith('D'), hash: z.string().length(64) }).strict()

export function specsModal(snapshot: SpecSnapshot, metadata: z.infer<typeof metadataSchema>, suggestion: string) {
  return {
    type: 'modal' as const, callback_id: 'kit_project_specs', private_metadata: JSON.stringify(metadata),
    title: { type: 'plain_text' as const, text: `Specs · ${snapshot.projectNumber}`.slice(0, 24) },
    submit: { type: 'plain_text' as const, text: 'Confirm specs' }, close: { type: 'plain_text' as const, text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'plain_text', text: 'Review ALL values below. Confirm writes them to the Production Control Center and marks this project’s specs Confirmed. A remembered assumption is not an approval. Use exact pixels and frame rate; Kit will not guess “4K”.' } },
      ...(suggestion ? [{ type: 'section', text: { type: 'plain_text', text: `Your request (not yet applied): ${suggestion.slice(0, 1200)}` } }] : []),
      ...FIELDS.map(([key, label, index, max]) => ({
        type: 'input', block_id: key, optional: index > 2,
        label: { type: 'plain_text', text: label },
        element: { type: 'plain_text_input', action_id: 'value', max_length: max,
          ...(snapshot.values[index] ? { initial_value: snapshot.values[index] } : {}) },
      })),
    ],
  }
}

export async function openProjectSpecs(client: WebClient, input: SpecContext & { triggerId: string; suggestion?: string }): Promise<void> {
  // Consume Slack's short-lived trigger immediately. This empty loading shell
  // exposes no project data; authorization precedes every subsequent read/write.
  const shell = (text: string) => ({ type: 'modal' as const, title: { type: 'plain_text' as const, text: 'Project specs' },
    close: { type: 'plain_text' as const, text: 'Close' }, blocks: [{ type: 'section' as const, text: { type: 'plain_text' as const, text } }] })
  const opened = await client.views.open({ trigger_id: input.triggerId, view: shell('Checking your permissions and loading the current specs…') })
  if (!opened.ok || !opened.view?.id) throw new Error('Specs form could not open')
  try {
    const { user, teamId, project, config } = await resolveSpecs(client, input, true)
    const snapshot = await readBoundProjectSpecs(config, project.id)
    const dm = await client.conversations.open({ users: input.userId })
    if (!dm.ok || !dm.channel?.id?.startsWith('D')) throw new Error('Your private Kit DM could not be opened.')
    await client.views.update({ view_id: opened.view.id, view: specsModal(snapshot, {
      projectId: project.id, workspaceId: user.workspaceId, teamId, actor: input.userId,
      source: input.channelId, dm: dm.channel.id, hash: snapshot.hash,
    }, input.suggestion || '') as Parameters<WebClient['views']['open']>[0]['view'] })
  } catch (error) {
    await client.views.update({ view_id: opened.view.id, view: shell(safeSpecsError(error)) }).catch(() => {})
    throw error
  }
}

/** Private diagnostic codes only; raw provider errors never reach Slack/model. */
export function safeSpecsError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /^(Only a producer|Project specs|Project lookup|Specify one|This project is not connected|You need membership|Your private Kit|Specs changed since|Specs column layout|Project must have|The bound project)/.test(message)
    ? message : 'Kit could not verify the specs operation. Check the control sheet before retrying; no success is being claimed.'
}

export function registerProjectSpecsHandlers(app: App): void {
  app.view('kit_project_specs', async ({ ack, body, view, client }) => {
    const values = view.state.values
    const parsed = specEditSchema.safeParse(Object.fromEntries(FIELDS.map(([key]) => [key, values[key]?.value?.value || ''])))
    if (!parsed.success) {
      await ack({ response_action: 'errors', errors: Object.fromEntries(parsed.error.issues.map(issue => [String(issue.path[0]), issue.message])) })
      return
    }
    await ack()
    let raw: unknown
    try { raw = JSON.parse(view.private_metadata || '{}') } catch { return }
    const meta = metadataSchema.safeParse(raw)
    if (!meta.success || meta.data.actor !== body.user.id || meta.data.teamId !== body.team?.id) return
    const m = meta.data
    let claimedId: string | null = null
    let release: (() => Promise<void>) | undefined
    try {
      const scope = await resolveSpecs(client, { userId: body.user.id, teamId: body.team.id, channelId: m.source }, true, m.projectId)
      if (scope.user.workspaceId !== m.workspaceId) throw new Error('Workspace mismatch')
      const args = JSON.stringify({ projectId: m.projectId, expectedHash: m.hash, values: parsed.data })
      if (args.length > 1600) throw new Error('Specs request too long')
      const record = await saveCommandRequest({ request_key: createHash('sha256').update(`specs:${m.teamId}:${m.actor}:${view.id}`).digest('hex'),
        workspace_id: m.workspaceId, team_id: m.teamId, user_id: m.actor, source_channel: m.source,
        dm_channel: m.dm, command: 'setspecs', args })
      if (!record || !await claimCommandRequest(record)) return
      claimedId = record.id
      const holder = `specs:${record.id}:${randomUUID()}`
      if (!await claimWorkbookLease(scope.config.spreadsheetId, 'creation', holder)) throw new Error('Project specs are busy. Reopen the form shortly; nothing was written.')
      release = () => releaseWorkbookLease(scope.config.spreadsheetId, 'creation', holder)
      await writeBoundProjectSpecs(scope.config, scope.project.id, m.hash, parsed.data, async () => {
        if (!await renewWorkbookLease(scope.config.spreadsheetId, 'creation', holder)) throw new Error('Specs lease lost')
      })
      await finishCommandRequest(record.id, 'complete', true)
      let refresh = 'The normal sync will update the project tabs; that has not been verified yet.'
      try { refresh = await requestSlackProjectRefresh(client, { userId: m.actor, teamId: m.teamId, channelId: m.source, code: scope.project.project_code || undefined }) }
      catch { /* Sheet saved; do not misreport a refresh failure as a write failure. */ }
      await client.chat.postMessage({ channel: m.dm, text: `Confirmed specs saved and verified in the Production Control Center.\n${SPEC_HEADERS[1]}: ${parsed.data.dimensions}\nFrame Rate: ${parsed.data.frameRate}\n${refresh}` })
    } catch (error) {
      console.warn('[specs] operation failed', { stage: claimedId ? 'confirmed-write' : 'authorization', code: error instanceof Error ? error.name : 'unknown' })
      if (claimedId) await finishCommandRequest(claimedId, 'review', true).catch(() => {})
      await client.chat.postMessage({ channel: m.dm, text: safeSpecsError(error) })
    } finally { await release?.().catch(() => {}) }
  })
}
