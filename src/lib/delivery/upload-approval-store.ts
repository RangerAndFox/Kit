import { createAdminClient } from '../supabase/admin'
import { approvedRenameMatches, buildUploadRenameIntent, suggestedUploadName, uploadReviewers, type RenameMetadata, type UploadApproval, type UploadSource } from './upload-approval'
import type { Json } from '../../types/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'

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

/** Journal before moving Dropbox. A crash after move can then resume the same
 * approval without treating our own metadata-only revision as new media. */
export async function recordUploadRenameIntent(row: UploadApproval, current: RenameMetadata): Promise<UploadApproval> {
  const intent = buildUploadRenameIntent(row, current)
  const payload = row.source_payload && typeof row.source_payload === 'object' && !Array.isArray(row.source_payload) ? row.source_payload : {}
  const source_payload = { ...payload, rename_intent: intent } as unknown as Json
  const { data, error } = await createAdminClient().from('frame_upload_approvals').update({
    source_payload, updated_at: new Date().toISOString(),
  }).eq('id', row.id).eq('workspace_id', row.workspace_id).eq('state', 'approved')
    .eq('approval_version', row.approval_version).is('upload_attempted_at', null).select('id').maybeSingle()
  if (error || !data) throw new Error('Rename intent checkpoint failed or approval ownership changed')
  return { ...row, source_payload }
}

/** Per-file lookup, not a queue-wide scan. Unknown DB outcomes fail closed.
 * Suppress only a verified metadata change from an already-decided request. */
export async function hasApprovedRename(projectId: string, current: RenameMetadata): Promise<boolean> {
  if (!current.content_hash || !/^[a-f0-9]{64}$/i.test(current.content_hash) || !current.path_display) return false
  const { data, error } = await createAdminClient().from('frame_upload_approvals').select('*')
    .eq('project_id', projectId).eq('source_file_id', current.id)
    .in('state', ['approved','uploading','collision','complete','needs_review','skipped'])
    .contains('source_payload', { rename_intent: { target_path: current.path_display.toLowerCase(), content_hash: current.content_hash.toLowerCase() } })
    .limit(2)
  if (error) throw new Error('Could not verify previous upload rename')
  return (data || []).some(row => approvedRenameMatches(row, current))
}

export async function createUploadApproval(projectId: string, source: UploadSource, size: number): Promise<void> {
  const db = createAdminClient()
  const { data: project, error: projectError } = await db.from('projects').select('workspace_id,client,name,status').eq('id', projectId).single()
  if (projectError || !project) throw new Error('Upload project unavailable')
  if (['archived','cancelled'].includes(project.status || '')) return
  // Atomic registration handles same-path replacements across changed IDs,
  // out-of-order observations, receipt reconciliation and logical-card identity.
  const { error } = await (db as unknown as SupabaseClient).rpc('register_frame_upload_source', {
    p_project: projectId, p_source: { ...source, sizeBytes: size }, p_size: size,
    p_suggested: suggestedUploadName(project.client, project.name, source.name),
  })
  if (error) throw error
}

/** A candidate receipt is not live provider proof. The caller must verify the
 * Frame identity/destination/exact bytes/readiness before treating it as seen. */
export async function completedUploadReceipt(projectId:string,source:UploadSource,size:number):Promise<UploadApproval|null> {
  if(!source.content_hash||!/^[a-f0-9]{64}$/i.test(source.content_hash)) return null
  const {data,error}=await (createAdminClient() as unknown as SupabaseClient).rpc('find_completed_frame_upload_receipt',{
    p_project:projectId,p_path:source.path,p_size:size,p_hash:source.content_hash.toLowerCase(),
  })
  if(error) throw new Error('Completed upload receipt lookup unavailable')
  return data as UploadApproval|null
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
