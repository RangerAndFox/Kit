import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '../supabase/admin'
import { assertUploadReviewer } from './upload-approval-store'
import type { UploadPackagePage } from './upload-package'
import type { UploadApproval } from './upload-approval'

export async function uploadApprovalUsesPackage(row: UploadApproval): Promise<boolean> {
  if (!row.review_slot_id) return false
  const { data, error } = await (createAdminClient() as unknown as SupabaseClient).from('frame_upload_review_slots')
    .select('package_id').eq('id', row.review_slot_id).eq('workspace_id', row.workspace_id).eq('project_id', row.project_id).single()
  if (error || !data) throw new Error('Upload notification ownership unavailable')
  return Boolean(data.package_id)
}

export async function getUploadPackagePage(id: string, after: string | null = null): Promise<UploadPackagePage> {
  const { data, error } = await (createAdminClient() as unknown as SupabaseClient).rpc('get_frame_upload_package_page', {
    p_id: id, p_after: after, p_limit: 10,
  })
  if (error || !data || data.package?.id !== id) throw new Error('Delivery folder review unavailable. Try Refresh.')
  return data as UploadPackagePage
}

/** Read only identity before checking the authenticated Slack workspace and
 * current project role. File names and paths are not loaded until authorized. */
export async function getAuthorizedUploadPackagePage(id: string, after: string | null, team: string, actor: string): Promise<UploadPackagePage> {
  const db = createAdminClient() as unknown as SupabaseClient
  const { data: identity, error } = await db.from('frame_upload_review_packages')
    .select('id,workspace_id,project_id').eq('id', id).single()
  if (error || !identity) throw new Error('Delivery folder review unavailable.')
  const { data: workspace, error: workspaceError } = await db.from('workspaces')
    .select('id').eq('slack_team_id', team).single()
  if (workspaceError || workspace?.id !== identity.workspace_id) throw new Error('This delivery folder belongs to another workspace.')
  await assertUploadReviewer(identity, actor)
  const page = await getUploadPackagePage(id, after)
  if (page.package.workspace_id !== identity.workspace_id || page.package.project_id !== identity.project_id ||
    page.approvals.some(row => row.workspace_id !== identity.workspace_id || row.project_id !== identity.project_id)) {
    throw new Error('Delivery folder scope changed. Reopen the current card.')
  }
  return page
}
