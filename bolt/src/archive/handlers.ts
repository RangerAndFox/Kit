// @ts-nocheck
import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { resolveUserContext } from '../../../src/lib/inngest/access-control'
import { projectNumberFromCode } from '../../../src/lib/studio-knowledge/project-sync'
import { inngest } from '../../../src/lib/inngest/client'
import { configuredArchiveDestinations } from '../../../src/lib/archive/adapters'
import { archiveSettingsFromSlack, buildArchiveConfirmationCard, buildArchiveModal, buildArchiveProgressCard, buildArchiveProjectCard } from '../../../src/lib/archive/blocks'
import { findDeliveryVideos } from '../../../src/lib/archive/dropbox'
import { claimArchiveJob, createArchiveJob, getArchiveJob, requeueArchiveJob, saveArchiveSlackMessage, updateArchiveJob } from '../../../src/lib/archive/store'
import { runArchiveJob } from '../../../src/lib/archive/workflow'
import type { ArchiveProjectSnapshot } from '../../../src/lib/archive/types'

const db = () => createAdminClient() as any

async function resolveWorkspaceId(teamId: string): Promise<string> {
  if (teamId) {
    const { data } = await db().from('workspaces').select('id').eq('slack_team_id', teamId).limit(1).maybeSingle()
    if (data?.id) return data.id
  }
  if (process.env.KIT_DEFAULT_WORKSPACE_ID) return process.env.KIT_DEFAULT_WORKSPACE_ID
  const { data } = await db().from('workspaces').select('id').limit(1).maybeSingle()
  return data?.id || ''
}

async function archiveAccess(client: any, workspaceId: string, userId: string): Promise<any | null> {
  let email: string | undefined
  try { email = (await client.users.info({ user: userId }))?.user?.profile?.email || undefined } catch {}
  const context = await resolveUserContext(workspaceId, userId, email)
  return context && (context.tier === 'admin' || context.tier === 'producer') ? context : null
}

const projectLabel = (row: any) => [projectNumberFromCode(row.project_code), row.client, row.name].filter(Boolean).join(' — ')

async function listArchiveProjects(workspaceId: string): Promise<any[]> {
  const { data, error } = await db().from('projects')
    .select('id,name,client,project_code,status,slack_channel_id,external_links,external_ids')
    .eq('workspace_id', workspaceId)
    .not('status', 'in', '("archived","cancelled","provisioning")')
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw new Error(`Could not load archive projects: ${error.message}`)
  return data || []
}

export async function buildArchiveCardForContext(opts: { teamId: string; channelId: string; userId: string; client: any }): Promise<any> {
  const workspaceId = await resolveWorkspaceId(opts.teamId)
  if (!workspaceId || !await archiveAccess(opts.client, workspaceId, opts.userId)) {
    throw new Error('Archive publishing is restricted to producers and admins.')
  }
  const rows = await listArchiveProjects(workspaceId)
  const inferredRow = rows.find((row) => row.slack_channel_id === opts.channelId || row.external_links?.slack_id === opts.channelId)
  const options = rows.map((row) => ({ id: row.id, label: projectLabel(row) }))
  return buildArchiveProjectCard(options, inferredRow ? { id: inferredRow.id, label: projectLabel(inferredRow) } : null)
}

async function loadArchiveSnapshot(projectId: string): Promise<{ snapshot: ArchiveProjectSnapshot; workspaceId: string }> {
  const { data, error } = await db().from('projects')
    .select('id,workspace_id,name,client,project_code,external_ids,external_links,slack_channel_id,status')
    .eq('id', projectId)
    .maybeSingle()
  if (error || !data) throw new Error(`Could not load project: ${error?.message || 'not found'}`)
  if (['archived', 'cancelled', 'provisioning'].includes(data.status)) throw new Error('That project is not eligible for archive publishing.')
  const projectNumber = data.external_ids?.project_number || projectNumberFromCode(data.project_code) || ''
  const safeName = data.external_ids?.dropbox_safe_name || ''
  const year = projectNumber ? `20${projectNumber.slice(0, 2)}` : ''
  const dropboxProjectPath = data.external_links?.dropbox_id || (safeName && year ? `/production/${year}/${safeName}` : '')
  return {
    workspaceId: data.workspace_id,
    snapshot: {
      projectId: data.id,
      projectNumber,
      client: data.client || '',
      projectName: data.name || '',
      dropboxProjectPath,
      slackChannelId: data.slack_channel_id || data.external_links?.slack_id || undefined,
    },
  }
}

async function openArchiveModal(client: any, triggerId: string, projectId: string, channelId: string, userId: string): Promise<void> {
  const { snapshot, workspaceId } = await loadArchiveSnapshot(projectId)
  if (!await archiveAccess(client, workspaceId, userId)) throw new Error('Archive publishing is restricted to producers and admins.')
  const videos = snapshot.dropboxProjectPath ? await findDeliveryVideos(snapshot.dropboxProjectPath) : []
  await client.views.open({
    trigger_id: triggerId,
    view: buildArchiveModal({
      snapshot,
      workspaceId,
      channelId,
      sourceVideoPath: videos[0]?.path,
      detectedVideos: videos.map((video) => video.path),
      destinations: configuredArchiveDestinations(),
    }),
  })
}

async function postPrivateConfirmation(client: any, userId: string, job: any): Promise<void> {
  const dm = await client.conversations.open({ users: userId })
  if (!dm.channel?.id) throw new Error('Could not open a private conversation with Kit.')
  const card = buildArchiveConfirmationCard(job)
  const posted = await client.chat.postMessage({ channel: dm.channel.id, text: card.text, blocks: card.blocks })
  await saveArchiveSlackMessage(job.id, dm.channel.id, posted.ts)
}

export function registerArchiveHandlers(app: App): void {
  const open = async ({ ack, body, client, projectId }: any) => {
    await ack()
    try {
      await openArchiveModal(client, body.trigger_id, projectId, body.channel?.id || body.container?.channel_id || '', body.user.id)
    } catch (error: any) {
      await client.chat.postMessage({ channel: body.user.id, text: `:warning: Couldn't open the archive form: ${error.message}` })
    }
  }

  app.action('kit_open_archive_modal', async (args: any) => open({ ...args, projectId: args.action.value }))
  app.action('kit_pick_archive_project', async (args: any) => open({ ...args, projectId: args.action.selected_option?.value }))
  app.action('kit_archive_cancel_picker', async ({ ack }: any) => ack())

  app.view('kit_archive_project_submit', async ({ ack, body, view, client }: any) => {
    const meta = JSON.parse(view.private_metadata || '{}')
    const parsed = archiveSettingsFromSlack(view.state?.values || {})
    const errors: Record<string, string> = {}
    if (!parsed.sourceVideoPath) errors.source_video = 'Choose the approved Dropbox source video.'
    if (!parsed.settings.rightsConfirmed) errors.rights = 'You must confirm approval and portfolio rights.'
    if (!parsed.destinations.length) errors.destinations = 'Choose at least one destination.'
    if (Object.keys(errors).length) { await ack({ response_action: 'errors', errors }); return }

    await ack()
    try {
      const access = await archiveAccess(client, meta.workspaceId, body.user.id)
      if (!access) throw new Error('Archive publishing is restricted to producers and admins.')
      const { snapshot } = await loadArchiveSnapshot(meta.projectId)
      const job = await createArchiveJob({
        workspace_id: meta.workspaceId,
        project_id: meta.projectId,
        requested_by_slack_user_id: body.user.id,
        source_video_path: parsed.sourceVideoPath,
        project_snapshot: snapshot,
        settings: parsed.settings,
        destinations: parsed.destinations,
        slack_channel_id: null,
        slack_message_ts: null,
        idempotency_key: `slack-view:${view.id}`,
      } as any)
      await postPrivateConfirmation(client, body.user.id, job)
    } catch (error: any) {
      await client.chat.postMessage({ channel: body.user.id, text: `:x: Kit couldn't prepare the archive review: ${error.message}` })
    }
  })

  app.action('kit_archive_confirm', async ({ ack, body, action, client }: any) => {
    await ack()
    const existing = await getArchiveJob(action.value)
    if (!existing) return
    if (!await archiveAccess(client, existing.workspace_id, body.user.id)) {
      await client.chat.postMessage({ channel: body.user.id, text: ':lock: Archive publishing is restricted to producers and admins.' })
      return
    }
    const claimed = await claimArchiveJob(existing.id)
    const job = claimed || await getArchiveJob(existing.id)
    if (!job) return
    await client.chat.update({ channel: job.slack_channel_id, ts: job.slack_message_ts, ...buildArchiveProgressCard(job) })
    if (!claimed) return
    try {
      await inngest.send({ name: 'archive/job.requested', id: `archive:${job.id}:${job.attempt}`, data: { job_id: job.id } })
    } catch (error: any) {
      // Railway may be deployed before its Inngest event key is configured.
      // The durable job still runs in-process and every step remains resumable.
      console.warn('[archive] Inngest send failed; using durable local fallback:', error.message)
      void runArchiveJob(job.id).catch((err) => console.error('[archive] local fallback failed:', err.message))
    }
  })

  app.action('kit_archive_retry', async ({ ack, body, action, client }: any) => {
    await ack()
    const existing = await getArchiveJob(action.value)
    if (!existing || !await archiveAccess(client, existing.workspace_id, body.user.id)) return
    const requeued = await requeueArchiveJob(existing.id)
    if (!requeued) return
    await client.chat.update({ channel: requeued.slack_channel_id, ts: requeued.slack_message_ts, ...buildArchiveProgressCard(requeued) })
    try {
      await inngest.send({ name: 'archive/job.requested', id: `archive:${requeued.id}:${requeued.attempt}`, data: { job_id: requeued.id } })
    } catch (error: any) {
      console.warn('[archive] retry Inngest send failed; using durable local fallback:', error.message)
      void runArchiveJob(requeued.id).catch((err) => console.error('[archive] local retry failed:', err.message))
    }
  })

  app.action('kit_archive_cancel', async ({ ack, body, action, client }: any) => {
    await ack()
    const job = await getArchiveJob(action.value)
    if (!job) return
    if (job.requested_by_slack_user_id !== body.user.id && !await archiveAccess(client, job.workspace_id, body.user.id)) return
    if (job.status !== 'awaiting_confirmation') return
    const cancelled = await updateArchiveJob(job.id, { status: 'cancelled', progress: { message: 'Cancelled before any external work began.' }, completed_at: new Date().toISOString() } as any)
    await client.chat.update({ channel: cancelled.slack_channel_id, ts: cancelled.slack_message_ts, ...buildArchiveProgressCard(cancelled) })
  })
}
