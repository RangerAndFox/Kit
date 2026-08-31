export const PROJECT_DELETION_STEPS = [
  'cancel_jobs',
  'dropbox',
  'frameio',
  'harvest',
  'boords',
  'slack_canvases',
  'google_sheet',
  'slack_channel',
  'database',
] as const

export type ProjectDeletionStep = typeof PROJECT_DELETION_STEPS[number]
export type ProjectDeletionStatus = 'awaiting_confirmation' | 'running' | 'partial' | 'complete' | 'cancelled'

export interface ProjectDeletionSnapshot {
  projectId: string
  workspaceId: string
  projectNumber: string
  client: string
  projectName: string
  slackChannelId?: string
  canvasIds: string[]
  dropboxPath?: string
  frameioProjectId?: string
  harvestProjectId?: number
  boordsStoryboardId?: string
  hasSheetBinding: boolean
  /** Linked resources that Kit cannot prove it owns and therefore will retain. */
  retainedLinks: string[]
}

export interface ProjectDeletionRequest {
  id: string
  workspace_id: string
  project_id: string
  requested_by_slack_user_id: string
  idempotency_key: string
  status: ProjectDeletionStatus
  project_snapshot: ProjectDeletionSnapshot
  error: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export function deletionConfirmationText(projectNumber: string): string {
  return `DELETE ${projectNumber}`
}

export function isDeleteProjectTrigger(text: string): boolean {
  return /^(?:\/kit\s+)?delete(?:\s+(?:a\s+)?project)?(?:\s+please)?[.!]?$/i.test((text || '').trim())
}
