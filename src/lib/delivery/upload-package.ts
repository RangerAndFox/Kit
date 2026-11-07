import type { UploadApproval } from './upload-approval'

/** Notification identity only. Every file keeps its own immutable approval. */
export type UploadReviewPackage = {
  id: string
  workspace_id: string
  project_id: string
  root_path: string
  generation: number
  notice_dirty: boolean
  slack_channel_id: string | null
  slack_message_ts: string | null
  blocked_reason?: string | null
}

export type UploadPackagePage = {
  package: UploadReviewPackage
  approvals: Array<UploadApproval & { frame_review_url?: string | null }>
  total: number
  awaiting: number
  next_cursor: string | null
}

export type UploadPackageLocation = { id: string; after: string | null }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseUploadPackageLocation(value: string): UploadPackageLocation {
  const input: unknown = JSON.parse(value)
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Open the current delivery folder card.')
  const { id, after } = input as Record<string, unknown>
  if (typeof id !== 'string' || !uuid.test(id) || (after != null && (typeof after !== 'string' || !uuid.test(after)))) {
    throw new Error('Open the current delivery folder card.')
  }
  return { id, after: typeof after === 'string' ? after : null }
}
