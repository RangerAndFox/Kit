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
  heartbeat_at: string | null
  attempt: number
  error: string | null
}
