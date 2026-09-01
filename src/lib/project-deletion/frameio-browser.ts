import { createAdminClient } from '../supabase/admin'

// Generated database types lag this migration until the next schema snapshot.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => createAdminClient() as any
const now = () => new Date().toISOString()

export interface FrameioDeletionJob {
  id: string
  project_id: string
  workspace_id: string
  frameio_project_id: string
  frameio_project_name: string
  frameio_project_url: string
  status: string
  claimed_by: string | null
  claimed_at: string | null
  heartbeat_at: string | null
  attempt: number
  error: string | null
}

export async function queueFrameioBrowserDeletion(input: {
  projectId: string
  workspaceId: string
  frameioProjectId: string
  frameioProjectName: string
  frameioProjectUrl: string
}): Promise<FrameioDeletionJob> {
  const { data: existing, error: readError } = await db().from('frameio_project_deletion_jobs')
    .select('*').eq('frameio_project_id', input.frameioProjectId).maybeSingle()
  if (readError) throw new Error(`Frame.io browser deletion lookup failed: ${readError.message}`)
  // The caller only queues this fallback after a fresh provider GET proved the
  // project still exists. Reset even a previously completed job so a restored
  // Frame.io project cannot be mistaken for an already-finished deletion.
  const payload = {
    project_id: input.projectId,
    workspace_id: input.workspaceId,
    frameio_project_id: input.frameioProjectId,
    frameio_project_name: input.frameioProjectName,
    frameio_project_url: input.frameioProjectUrl,
    status: 'queued',
    claimed_by: null,
    claimed_at: null,
    heartbeat_at: null,
    error: null,
    completed_at: null,
    updated_at: now(),
  }
  const query = existing
    ? db().from('frameio_project_deletion_jobs').update(payload).eq('id', existing.id)
    : db().from('frameio_project_deletion_jobs').insert(payload)
  const { data, error } = await query.select('*').single()
  if (error || !data) throw new Error(`Frame.io browser deletion queue failed: ${error?.message || 'no row returned'}`)
  return data
}

export async function waitForFrameioBrowserDeletion(jobId: string, timeoutMs = 120_000): Promise<FrameioDeletionJob> {
  const deadline = Date.now() + timeoutMs
  do {
    const { data, error } = await db().from('frameio_project_deletion_jobs').select('*').eq('id', jobId).maybeSingle()
    if (error || !data) throw new Error(`Frame.io browser deletion read failed: ${error?.message || 'job missing'}`)
    if (data.status === 'complete') return data
    if (['failed', 'cancelled'].includes(data.status)) {
      throw new Error(`Frame.io browser deletion ${data.status}: ${data.error || 'unknown error'}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  } while (Date.now() < deadline)
  throw new Error('Frame.io deletion is queued for the studio browser worker; retry when the worker is online.')
}
