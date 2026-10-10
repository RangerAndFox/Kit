import { createAdminClient } from '../supabase/admin'
import { suggestedUploadName, uploadReviewers, type UploadApproval, type UploadSource } from './upload-approval'
import type { Json } from '../../types/supabase'

export const uploadApprovalsEnabled = () => process.env.FRAMEIO_UPLOAD_APPROVALS_ENABLED === 'true'

export async function assertUploadReviewer(row: UploadApproval, user: string): Promise<void> {
  const db = createAdminClient()
  const { data: project, error } = await db.from('projects').select('project_manager_slack_id,external_ids,status')
    .eq('id', row.project_id).eq('workspace_id', row.workspace_id).single()
  if (error || !project || ['archived','cancelled'].includes(project.status || '')) throw new Error('This project is not active.')
  const { data: member, error: memberError } = await db.from('team_members').select('role,is_active')
    .eq('workspace_id', row.workspace_id).eq('slack_user_id', user).maybeSingle()
  if (memberError) throw new Error('Could not verify your access.')
  if (member?.is_active === false || (!uploadReviewers(project).includes(user) && !['admin','founder','owner'].includes(member?.role || ''))) {
    throw new Error('Only this project’s current producer, CD, or a Kit admin can approve.')
  }
}

export async function getUploadApproval(id: string): Promise<UploadApproval> {
  const { data, error } = await createAdminClient().from('frame_upload_approvals').select('*').eq('id', id).single()
  if (error || !data) throw new Error('Upload request unavailable')
  return data
}

export async function updateUploadApproval(id: string, changes: Partial<UploadApproval>): Promise<void> {
  const { error } = await createAdminClient().from('frame_upload_approvals')
    .update({ ...changes, notice_dirty: true, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) throw new Error(`Upload request checkpoint failed: ${error.message}`)
}

export async function createUploadApproval(projectId: string, source: UploadSource, size: number): Promise<void> {
  const db = createAdminClient()
  const { data: project, error: projectError } = await db.from('projects').select('workspace_id,client,name,status').eq('id', projectId).single()
  if (projectError || !project) throw new Error('Upload project unavailable')
  if (['archived','cancelled'].includes(project.status || '')) return
  // Old cards can never approve the new revision. Already-uploading work keeps
  // its own checkpoint and completes without re-uploading.
  const { error: supersedeError } = await db.from('frame_upload_approvals').update({
    state: 'superseded', detail: 'A newer Dropbox revision needs its own approval.', notice_dirty: true, updated_at: new Date().toISOString(),
  }).eq('project_id', projectId).eq('source_file_id', source.dropboxId).neq('source_rev', source.rev)
    .in('state', ['awaiting','approved','collision']).is('upload_attempted_at', null)
  if (supersedeError) throw supersedeError
  const { error } = await db.from('frame_upload_approvals').upsert({
    workspace_id: project.workspace_id, project_id: projectId, source_file_id: source.dropboxId,
    source_rev: source.rev, source_size: size, source_path: source.path,
    source_payload: { ...source, sizeBytes: size } as unknown as Json,
    suggested_name: suggestedUploadName(project.client, project.name, source.name),
  }, { onConflict: 'project_id,source_file_id,source_rev', ignoreDuplicates: true })
  if (error) throw error
}

/** Fence the ambiguous external-write window. A retry may resume a persisted
 * transfer, but cannot repeat a POST whose outcome was never checkpointed. */
export async function claimUploadPost(row: UploadApproval): Promise<boolean> {
  const { data, error } = await createAdminClient().from('frame_upload_approvals').update({
    state: 'uploading', upload_attempted_at: new Date().toISOString(), notice_dirty: true, updated_at: new Date().toISOString(),
  }).eq('id', row.id).eq('state', 'approved').eq('approval_version', row.approval_version)
    .is('upload_attempted_at', null).select('id').maybeSingle()
  if (error) throw error
  return !!data
}
