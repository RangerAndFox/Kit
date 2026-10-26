import type { Json } from '../../types/supabase'

export type UploadApproval = {
  id: string; workspace_id: string; project_id: string
  source_file_id: string; source_rev: string; source_size: number; source_path: string; source_payload: Json
  suggested_name: string; state: string; approval_version: number
  approved_name: string | null; decision: string | null; approved_by: string | null; approved_at: string | null
  conflict_id: string | null; conflict_type: string | null; destination_key: string | null
  upload_attempted_at: string | null; frame_file_id: string | null; version_stack_id: string | null; renamed_path: string | null
  slack_channel_id: string | null; slack_message_ts: string | null; notice_claimed_at: string | null
  collision_channel_id: string | null; collision_message_ts: string | null
  notice_token: string | null; notice_dirty: boolean; detail: string | null; created_at: string; updated_at: string
  review_slot_id?: string | null; review_notice_closed?: boolean
}

export interface UploadSource {
  path: string; name: string; safeName: string; subfolder: string; year: string; dropboxId: string; rev: string
  sizeBytes?: number; approvalRequestId?: string; approvalVersion?: number
  content_hash?: string; source_modified_at?: string
  verified_frame_file_id?: string
}

export type RenameMetadata = { id: string; rev: string; size: number; path_display: string; content_hash?: string }
export type UploadRenameIntent = {
  file_id: string; source_rev: string; size: number; content_hash: string
  target_path: string; approved_by: string; approval_version: number
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')).toLowerCase()

/** Only Kit's persisted rename intent permits a revision change. Equal sizes
 * alone are never evidence of equal media. Keep the approved revision pinned. */
export function approvedRenameMatches(row: UploadApproval, current: RenameMetadata): boolean {
  const intent = record(record(row.source_payload).rename_intent)
  return intent.file_id === row.source_file_id && intent.source_rev === row.source_rev &&
    intent.size === row.source_size && typeof intent.content_hash === 'string' && /^[a-f0-9]{64}$/.test(intent.content_hash) &&
    intent.approved_by === row.approved_by && !!row.approved_by &&
    Number.isInteger(intent.approval_version) && Number(intent.approval_version) > 0 && Number(intent.approval_version) <= row.approval_version &&
    typeof intent.target_path === 'string' && parentPath(intent.target_path) === parentPath(row.source_path) &&
    current.id === row.source_file_id && current.size === row.source_size &&
    typeof current.rev === 'string' && /^[a-f0-9]{9,}$/.test(current.rev) &&
    typeof current.content_hash === 'string' && current.content_hash.toLowerCase() === intent.content_hash &&
    typeof current.path_display === 'string' && current.path_display.toLowerCase() === intent.target_path
}

export function buildUploadRenameIntent(row: UploadApproval, current: RenameMetadata): UploadRenameIntent {
  const exact = current.id === row.source_file_id && current.rev === row.source_rev && current.size === row.source_size &&
    typeof current.path_display === 'string' && current.path_display.toLowerCase() === row.source_path.toLowerCase()
  if ((!exact && !approvedRenameMatches(row, current)) || !row.approved_by || !row.approved_name ||
    validateUploadName(row.approved_name, row.source_path) || !Number.isSafeInteger(row.source_size) || row.source_size <= 0 ||
    !current.content_hash || !/^[a-f0-9]{64}$/i.test(current.content_hash)) {
    throw new Error('Cannot verify the approved Dropbox content before renaming')
  }
  return { file_id: row.source_file_id, source_rev: row.source_rev, size: row.source_size,
    content_hash: current.content_hash.toLowerCase(),
    target_path: `${parentPath(row.source_path)}/${row.approved_name}`.toLowerCase(),
    approved_by: row.approved_by, approval_version: row.approval_version }
}

const segment = (value: string) => value.replace(/^\d{4}[A-Za-z]?[_\s-]+/, '')
  .replace(/[^\p{L}\p{N}&-]+/gu, '_').replace(/^_+|_+$/g, '')
export const extension = (name: string) => /\.[a-z0-9]{1,8}$/i.exec(name)?.[0] || ''

/** Only reuse an explicit phase/version, never invent a milestone from a date. */
export function suggestedUploadName(client: string, project: string, source: string): string {
  const leaf = source.split('/').pop() || source
  // A valid client-facing name is already useful; do not discard its details.
  if (!validateUploadName(leaf, leaf) && !/Phase_Version/i.test(leaf)) return leaf
  const match = /(?:^|[_\s-])(anim(?:ation)?|edit|storyboard|boards?|styleframes?|design|final|delivery)(?:[_\s-]*([rv]\d+))?(?=[_\s.-]|$)/i.exec(leaf)
  const suffix = match ? `_${[match[1], match[2]].filter(Boolean).join('_')}` : ''
  return `R&F_${segment(client)}_${segment(project)}${suffix}${extension(leaf)}`
}

export function validateUploadName(name: string, original: string): string | null {
  const stem = name.slice(0, name.length - extension(name).length)
  if (!/^R&F_[^_/\\]+(?:_[^_/\\]+)+$/.test(stem) || name.length > 240 || /[\x00-\x1f\x7f<>:|?*]/.test(name)) return 'Use R&F_Client_Project, optionally followed by a phase or version, with no path or reserved characters.'
  if (/(?:^|_)\d{4}[a-z]?(?=_)/i.test(name)) return 'Leave internal project numbers out of the client-facing filename.'
  if (extension(name).toLowerCase() !== extension(original).toLowerCase()) return 'Keep the original file extension.'
  return null
}

export function distinctUploadName(name: string, occupied: string[]): string {
  const ext = extension(name), stem = name.slice(0, name.length - ext.length)
  const used = new Set(occupied.map(n => n.toLowerCase()))
  for (let i = 2; i < 1000; i++) {
    const next = `${stem}_${String(i).padStart(2, '0')}${ext}`
    if (!used.has(next.toLowerCase())) return next
  }
  throw new Error('Too many same-name files; choose a different name.')
}

export function approvalMatches(row: UploadApproval, source: UploadSource, projectId: string): boolean {
  return row.project_id === projectId && row.source_file_id === source.dropboxId && row.source_rev === source.rev &&
    row.approval_version === source.approvalVersion && ['approved', 'uploading'].includes(row.state)
}

export function uploadReviewers(project: { project_manager_slack_id?: string | null; external_ids?: Json }): string[] {
  const ids = project.external_ids && typeof project.external_ids === 'object' && !Array.isArray(project.external_ids) ? project.external_ids : {}
  return [...new Set([project.project_manager_slack_id, ids.creative_director_slack_id]
    .filter((id): id is string => typeof id === 'string' && /^[UW][A-Z0-9]+$/.test(id)))]
}
