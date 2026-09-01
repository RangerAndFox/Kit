export type BehanceJobStatus =
  | 'queued' | 'claimed' | 'opening_editor' | 'uploading_media'
  | 'filling_details' | 'saving_draft' | 'awaiting_review'
  | 'retryable' | 'failed' | 'cancelled'

export interface BehanceManifest {
  title: string
  subtitle?: string
  descriptions: string[]
  excerpt?: string
  credits?: string
  services: string[]
  tags: string[]
  media: string[]
  contentModules?: BehanceContentModule[]
  vimeoUrl?: string | null
  archiveFolderPath?: string | null
  backgroundColor?: string
}

export type BehanceTextRole = 'title' | 'description' | 'heading' | 'credits'
export type BehanceContentModule =
  | { kind: 'text'; role: BehanceTextRole; text: string }
  | { kind: 'media'; paths: string[] }

export interface BehanceDraftJob {
  id: string
  archive_job_id: string
  workspace_id: string
  project_id: string
  status: BehanceJobStatus
  manifest: BehanceManifest
  draft_url: string | null
  proof_dropbox_path: string | null
  proof_url: string | null
  claimed_by: string | null
  claimed_at: string | null
  heartbeat_at: string | null
  attempt: number
  error: string | null
}

export type ElevenLabsJobStatus =
  | 'queued' | 'claimed' | 'opening_studio' | 'filling_project'
  | 'saving_draft' | 'complete' | 'retryable' | 'failed' | 'cancelled'

export interface ElevenLabsStudioJob {
  id: string
  storyboard_job_id: string
  workspace_id: string | null
  requested_by_slack_user_id: string | null
  slack_channel_id: string | null
  slack_thread_ts: string | null
  status: ElevenLabsJobStatus
  project_name: string
  voiceover_paragraphs: string[]
  studio_project_id: string | null
  studio_url: string | null
  claimed_by: string | null
  claimed_at: string | null
  heartbeat_at: string | null
  attempt: number
  error: string | null
}

export type FrameioDeletionJobStatus =
  | 'queued' | 'claimed' | 'opening_project' | 'deleting' | 'verifying'
  | 'complete' | 'retryable' | 'failed' | 'cancelled'

export interface FrameioProjectDeletionJob {
  id: string
  project_id: string
  workspace_id: string
  frameio_project_id: string
  frameio_project_name: string
  frameio_project_url: string
  status: FrameioDeletionJobStatus
  claimed_by: string | null
  claimed_at: string | null
  heartbeat_at: string | null
  attempt: number
  error: string | null
}
