import type { Json } from '../../types/supabase'

export type UploadApproval = {
  id: string; workspace_id: string; project_id: string
  source_file_id: string; source_rev: string; source_size: number; source_path: string; source_payload: Json
  suggested_name: string; state: string; approval_version: number
  approved_name: string | null; decision: string | null; approved_by: string | null; approved_at: string | null
  conflict_id: string | null; conflict_type: string | null; destination_key: string | null
  upload_attempted_at: string | null; frame_file_id: string | null; version_stack_id: string | null; renamed_path: string | null
  slack_channel_id: string | null; slack_message_ts: string | null; notice_claimed_at: string | null
  notice_token: string | null; notice_dirty: boolean; detail: string | null; created_at: string; updated_at: string
}

export interface UploadSource {
  path: string; name: string; safeName: string; subfolder: string; year: string; dropboxId: string; rev: string
  sizeBytes?: number; approvalRequestId?: string; approvalVersion?: number
}

const segment = (value: string) => value.replace(/^\d{4}[A-Za-z]?[_\s-]+/, '')
  .replace(/[^\p{L}\p{N}&-]+/gu, '_').replace(/^_+|_+$/g, '')
export const extension = (name: string) => /\.[a-z0-9]{1,8}$/i.exec(name)?.[0] || ''

/** Only reuse an explicit phase/version, never invent a milestone from a date. */
export function suggestedUploadName(client: string, project: string, source: string): string {
  const leaf = source.split('/').pop() || source
  const match = /(?:^|[_\s-])(anim(?:ation)?|edit|storyboard|boards?|styleframes?|design|final|delivery)(?:[_\s-]*([rv]\d+))?(?=[_\s.-]|$)/i.exec(leaf)
  const suffix = match ? [match[1], match[2]].filter(Boolean).join('_') : 'Phase_Version'
  return `R&F_${segment(client)}_${segment(project)}_${suffix}${extension(leaf)}`
}

export function validateUploadName(name: string, original: string): string | null {
  if (!/^R&F_[^/\\]+_[^/\\]+_[^/\\]+$/.test(name) || name.length > 240 || /[\x00-\x1f\x7f<>:|?*]/.test(name)) return 'Use R&F_Client_Project_Phase and no path or reserved characters.'
  if (/Phase_Version/i.test(name)) return 'Replace Phase_Version with the actual phase, such as Anim_R1 or Edit_V2.'
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
