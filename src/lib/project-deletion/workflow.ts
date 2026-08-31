import { createAdminClient } from '../supabase/admin'
import { deleteDropboxProjectPath } from '../inngest/agents/dropbox'
import { deleteFrameioProject } from '../inngest/agents/frameio'
import { deleteHarvestProject } from '../harvest/client'
import { deleteStoryboard } from '../boords/client'
import { clearProjectControlProject } from '../project-control/sheets'
import { workbookConfigFromEnv } from '../project-control/types'
import {
  finishDeletionStep,
  getDeletionStep,
  getProjectDeletionRequest,
  setDeletionStatus,
  startDeletionStep,
} from './store'
import { PROJECT_DELETION_STEPS, type ProjectDeletionSnapshot, type ProjectDeletionStep } from './types'

const db = () => createAdminClient()

export interface SlackDeletionClient {
  apiCall(method: string, options: Record<string, unknown>): Promise<unknown>
  conversations: {
    rename(options: { channel: string; name: string }): Promise<unknown>
    archive(options: { channel: string }): Promise<unknown>
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const data = 'data' in error ? (error as { data?: unknown }).data : null
    if (data && typeof data === 'object' && 'error' in data) return String((data as { error?: unknown }).error || '')
  }
  return String(error)
}

export interface ProjectDeletionAdapters {
  run(step: ProjectDeletionStep, snapshot: ProjectDeletionSnapshot): Promise<Record<string, unknown> | null>
}

function optional(value: unknown): boolean {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0)
}

export function createProjectDeletionAdapters(slackClient: SlackDeletionClient): ProjectDeletionAdapters {
  return {
    async run(step, snapshot) {
      switch (step) {
        case 'cancel_jobs': {
          const { error } = await db().from('archive_jobs').update({
            status: 'cancelled',
            error: 'Cancelled because the Kit project was deleted.',
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('project_id', snapshot.projectId)
            .in('status', ['awaiting_confirmation', 'queued', 'validating', 'preparing_media', 'uploading_vimeo', 'creating_wordpress', 'creating_buffer', 'preparing_behance'])
          if (error) throw new Error(error.message)
          return { cancelled: true }
        }
        case 'dropbox':
          if (!snapshot.dropboxPath) return null
          await deleteDropboxProjectPath(snapshot.dropboxPath)
          return { path: snapshot.dropboxPath }
        case 'frameio':
          if (!snapshot.frameioProjectId) return null
          await deleteFrameioProject(snapshot.frameioProjectId)
          return { projectId: snapshot.frameioProjectId }
        case 'harvest':
          if (!snapshot.harvestProjectId) return null
          await deleteHarvestProject(snapshot.harvestProjectId)
          return { projectId: snapshot.harvestProjectId }
        case 'boords':
          if (!snapshot.boordsStoryboardId) return null
          await deleteStoryboard(snapshot.boordsStoryboardId)
          return { storyboardId: snapshot.boordsStoryboardId }
        case 'slack_canvases': {
          if (!snapshot.canvasIds.length) return null
          for (const canvasId of snapshot.canvasIds) {
            try {
              await slackClient.apiCall('canvases.delete', { canvas_id: canvasId })
            } catch (error: unknown) {
              const code = errorText(error)
              if (!/canvas_not_found/i.test(code)) throw error
            }
          }
          return { canvasIds: snapshot.canvasIds }
        }
        case 'google_sheet': {
          if (!snapshot.hasSheetBinding) return null
          const config = workbookConfigFromEnv()
          if (!config) throw new Error('Project Control workbook is not configured')
          return clearProjectControlProject(config, snapshot.projectId, snapshot.projectNumber)
        }
        case 'slack_channel': {
          if (!snapshot.slackChannelId) return null
          const suffix = snapshot.projectId.replace(/-/g, '').slice(0, 6)
          const number = snapshot.projectNumber.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase() || 'project'
          const name = `deleted-${number}-${suffix}`.slice(0, 80)
          try {
            await slackClient.conversations.rename({ channel: snapshot.slackChannelId, name })
          } catch (error: unknown) {
            const code = errorText(error)
            if (!/channel_not_found|already_archived|name_taken/i.test(code)) throw error
          }
          try {
            await slackClient.conversations.archive({ channel: snapshot.slackChannelId })
          } catch (error: unknown) {
            const code = errorText(error)
            if (!/channel_not_found|already_archived/i.test(code)) throw error
          }
          return { channelId: snapshot.slackChannelId, archivedAs: name }
        }
        case 'database': {
          const { error } = await db().from('projects').delete()
            .eq('id', snapshot.projectId).eq('workspace_id', snapshot.workspaceId)
          if (error) throw new Error(error.message)
          return { deleted: true }
        }
      }
    },
  }
}

export interface ProjectDeletionOutcome {
  status: 'complete' | 'partial'
  completed: ProjectDeletionStep[]
  skipped: ProjectDeletionStep[]
  failures: Array<{ step: ProjectDeletionStep; error: string }>
}

export interface ProjectDeletionStore {
  getRequest: typeof getProjectDeletionRequest
  setStatus: typeof setDeletionStatus
  getStep: typeof getDeletionStep
  startStep: typeof startDeletionStep
  finishStep: typeof finishDeletionStep
}

const defaultStore: ProjectDeletionStore = {
  getRequest: getProjectDeletionRequest,
  setStatus: setDeletionStatus,
  getStep: getDeletionStep,
  startStep: startDeletionStep,
  finishStep: finishDeletionStep,
}

/** External outputs are removed first. The Kit project row is never deleted if
 * any prior provider failed, retaining the identity needed for a safe retry. */
export async function runProjectDeletion(
  requestId: string,
  adapters: ProjectDeletionAdapters,
  store: ProjectDeletionStore = defaultStore,
): Promise<ProjectDeletionOutcome> {
  const request = await store.getRequest(requestId)
  if (!request) throw new Error(`Project deletion request ${requestId} not found`)
  if (request.status === 'cancelled') throw new Error('Project deletion request is cancelled')
  if (request.status === 'complete') return { status: 'complete', completed: [], skipped: [], failures: [] }
  await store.setStatus(requestId, 'running')

  const completed: ProjectDeletionStep[] = []
  const skipped: ProjectDeletionStep[] = []
  const failures: Array<{ step: ProjectDeletionStep; error: string }> = []
  for (const step of PROJECT_DELETION_STEPS) {
    const previous = await store.getStep(requestId, step)
    if (previous?.status === 'complete' || previous?.status === 'skipped') {
      ;(previous.status === 'complete' ? completed : skipped).push(step)
      continue
    }
    // The local database is the final commit. Never erase it when an external
    // provider still needs attention, because it carries every retry id.
    if (step === 'database' && failures.length > 0) break
    await store.startStep(requestId, step)
    try {
      const result = await adapters.run(step, request.project_snapshot)
      const status = optional(result) ? 'skipped' : 'complete'
      await store.finishStep(requestId, step, status, result || {})
      ;(status === 'complete' ? completed : skipped).push(step)
    } catch (error: unknown) {
      const message = errorText(error)
      failures.push({ step, error: message })
      await store.finishStep(requestId, step, 'failed', {}, message)
    }
  }

  if (failures.length > 0) {
    await store.setStatus(requestId, 'partial', failures.map((failure) => `${failure.step}: ${failure.error}`).join(' | '))
    return { status: 'partial', completed, skipped, failures }
  }
  await store.setStatus(requestId, 'complete')
  return { status: 'complete', completed, skipped, failures }
}
