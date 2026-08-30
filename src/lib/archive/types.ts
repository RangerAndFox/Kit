export const ARCHIVE_DESTINATIONS = ['dropbox', 'vimeo', 'wordpress', 'buffer', 'behance'] as const
export type ArchiveDestination = typeof ARCHIVE_DESTINATIONS[number]

export type ArchiveJobStatus =
  | 'awaiting_confirmation' | 'queued' | 'validating' | 'preparing_media'
  | 'uploading_vimeo' | 'creating_wordpress' | 'creating_buffer'
  | 'preparing_behance' | 'complete' | 'partial' | 'failed' | 'cancelled'

export interface ArchiveProjectSnapshot {
  projectId: string
  projectNumber: string
  client: string
  projectName: string
  dropboxProjectPath: string
  slackChannelId?: string
}

export interface ArchiveSettings {
  title: string
  subtitle: string
  year: string
  services: string[]
  description1: string
  description2: string
  description3: string
  credits: string
  socialCopy: string
  excerpt: string
  backgroundColor: string
  includeProcess: boolean
  rightsConfirmed: boolean
}

export interface ArchiveJob {
  id: string
  workspace_id: string
  project_id: string
  requested_by_slack_user_id: string
  status: ArchiveJobStatus
  source_video_path: string
  project_snapshot: ArchiveProjectSnapshot
  settings: ArchiveSettings
  destinations: ArchiveDestination[]
  progress: Record<string, unknown>
  results: Record<string, any>
  error: string | null
  slack_channel_id: string | null
  slack_message_ts: string | null
  idempotency_key: string
  attempt: number
  claim_token?: string | null
  claimed_by?: string | null
  claimed_at?: string | null
  created_at: string
  updated_at: string
}

export const isArchiveTrigger = (text: string): boolean =>
  /^\/?(archive|publish)(\s+(a\s+)?project)?(\s+please)?\.?$/i.test((text || '').trim())

export function archiveFolderName(snapshot: ArchiveProjectSnapshot): string {
  const safe = (value: string) => value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return [safe(snapshot.projectNumber), safe(snapshot.client), safe(snapshot.projectName)]
    .filter(Boolean)
    .join('_')
}
