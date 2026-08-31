import { createAdminClient } from '../supabase/admin'
import { getArchiveJob, updateArchiveJob } from './store'
import { getDropboxSharedLink } from './dropbox'

const db = () => createAdminClient() as any
const now = () => new Date().toISOString()

export async function queueBehanceDraft(archiveJobId: string, requestedBy: string): Promise<any> {
  const archive = await getArchiveJob(archiveJobId)
  if (!archive) throw new Error('Archive job not found.')
  const manifest = archive.results?.behance
  const { data: existing, error: readError } = await db().from('behance_draft_jobs')
    .select('*').eq('archive_job_id', archiveJobId).maybeSingle()
  if (readError) throw new Error(`Behance queue read failed: ${readError.message}`)
  if (existing && ['queued', 'claimed', 'opening_editor', 'uploading_media', 'filling_details', 'saving_draft', 'awaiting_review'].includes(existing.status)) {
    return existing
  }
  if (!manifest || !['ready', 'retryable', 'failed'].includes(manifest.status)) {
    throw new Error('The Behance package is not ready yet.')
  }

  const payload = {
    archive_job_id: archiveJobId,
    workspace_id: archive.workspace_id,
    project_id: archive.project_id,
    requested_by_slack_user_id: requestedBy,
    status: 'queued',
    manifest: { ...manifest, status: undefined, note: undefined },
    claimed_by: null,
    claimed_at: null,
    heartbeat_at: null,
    error: null,
    slack_synced_at: null,
    completed_at: null,
    updated_at: now(),
  }
  const query = existing
    ? db().from('behance_draft_jobs').update(payload).eq('id', existing.id)
    : db().from('behance_draft_jobs').insert(payload)
  const { data, error } = await query.select('*').single()
  if (error || !data) throw new Error(`Behance queue write failed: ${error?.message || 'no row returned'}`)

  const results = {
    ...(archive.results || {}),
    behance: { ...manifest, status: 'queued', draftJobId: data.id },
  }
  await updateArchiveJob(archiveJobId, { results } as any)
  return data
}

export async function listUnsyncedBehanceDrafts(): Promise<any[]> {
  const { data, error } = await db().from('behance_draft_jobs')
    .select('*')
    .in('status', ['awaiting_review', 'failed'])
    .order('updated_at', { ascending: true })
    .limit(50)
  if (error) throw new Error(`Behance sync read failed: ${error.message}`)
  return (data || []).filter((row: any) => !row.slack_synced_at || new Date(row.updated_at) > new Date(row.slack_synced_at))
}

export async function syncBehanceResultToArchive(row: any): Promise<any> {
  const archive = await getArchiveJob(row.archive_job_id)
  if (!archive) return null
  const previous = archive.results?.behance || {}
  const status = row.status === 'awaiting_review' ? 'awaiting_review' : 'failed'
  const proofUrl = row.proof_url || (row.proof_dropbox_path
    ? await getDropboxSharedLink(row.proof_dropbox_path)
    : null)
  if (row.status === 'awaiting_review' && row.proof_dropbox_path && !proofUrl) {
    throw new Error('Behance proof screenshot is still syncing to Dropbox.')
  }
  const results = {
    ...(archive.results || {}),
    behance: {
      ...previous,
      status,
      draftJobId: row.id,
      url: row.draft_url || previous.url || null,
      proofUrl,
      error: row.error || null,
    },
  }
  const updated = await updateArchiveJob(archive.id, { results } as any)
  const { error } = await db().from('behance_draft_jobs')
    .update({ slack_synced_at: now(), updated_at: row.updated_at })
    .eq('id', row.id)
  if (error) throw new Error(`Behance sync mark failed: ${error.message}`)
  return updated
}
