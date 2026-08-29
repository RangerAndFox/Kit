export type BehanceJobStatus =
  | 'queued' | 'claimed' | 'opening_editor' | 'uploading_media'
  | 'filling_details' | 'saving_draft' | 'awaiting_review'
  | 'retryable' | 'failed' | 'cancelled'

export interface BehanceManifest {
  title: string
  subtitle?: string
  descriptions: string[]
  credits?: string
  services: string[]
  tags: string[]
  media: string[]
  vimeoUrl?: string | null
  archiveFolderPath?: string | null
  backgroundColor?: string
}

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
  heartbeat_at: string | null
  attempt: number
  error: string | null
}
