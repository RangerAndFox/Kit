import { createAdminClient } from '../supabase/admin'
import type { Json } from '../../types/supabase'
import type { ProjectDeletionRequest, ProjectDeletionSnapshot, ProjectDeletionStatus, ProjectDeletionStep } from './types'

const db = () => createAdminClient()
const now = () => new Date().toISOString()

export async function createProjectDeletionRequest(input: {
  snapshot: ProjectDeletionSnapshot
  requestedBySlackUserId: string
  idempotencyKey: string
}): Promise<ProjectDeletionRequest> {
  const { data, error } = await db().from('project_deletion_requests').insert({
    workspace_id: input.snapshot.workspaceId,
    project_id: input.snapshot.projectId,
    requested_by_slack_user_id: input.requestedBySlackUserId,
    idempotency_key: input.idempotencyKey,
    status: 'awaiting_confirmation',
    project_snapshot: input.snapshot as unknown as Json,
  }).select('*').single()
  if (error) {
    if (error.code === '23505') {
      const { data: existing, error: readError } = await db().from('project_deletion_requests')
        .select('*').eq('idempotency_key', input.idempotencyKey).maybeSingle()
      if (!readError && existing) return existing as unknown as ProjectDeletionRequest
    }
    throw new Error(`createProjectDeletionRequest: ${error.message}`)
  }
  return data as unknown as ProjectDeletionRequest
}

export async function getProjectDeletionRequest(id: string): Promise<ProjectDeletionRequest | null> {
  const { data, error } = await db().from('project_deletion_requests').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`getProjectDeletionRequest: ${error.message}`)
  return data as unknown as ProjectDeletionRequest | null
}

export async function updateProjectDeletionRequest(
  id: string,
  patch: Partial<ProjectDeletionRequest>,
): Promise<void> {
  const { project_snapshot: snapshot, ...rest } = patch
  const dbPatch = {
    ...rest,
    ...(snapshot ? { project_snapshot: snapshot as unknown as Json } : {}),
    updated_at: now(),
  }
  const { error } = await db().from('project_deletion_requests').update(dbPatch).eq('id', id)
  if (error) throw new Error(`updateProjectDeletionRequest: ${error.message}`)
}

export async function getDeletionStep(requestId: string, step: ProjectDeletionStep): Promise<{ status: string } | null> {
  const { data, error } = await db().from('project_deletion_steps').select('*')
    .eq('request_id', requestId).eq('step_name', step).maybeSingle()
  if (error) throw new Error(`getDeletionStep: ${error.message}`)
  return data || null
}

export async function startDeletionStep(requestId: string, step: ProjectDeletionStep): Promise<void> {
  const { error } = await db().from('project_deletion_steps').upsert({
    request_id: requestId,
    step_name: step,
    status: 'running',
    error: null,
    started_at: now(),
    completed_at: null,
    updated_at: now(),
  }, { onConflict: 'request_id,step_name' })
  if (error) throw new Error(`startDeletionStep: ${error.message}`)
}

export async function finishDeletionStep(
  requestId: string,
  step: ProjectDeletionStep,
  status: 'complete' | 'failed' | 'skipped',
  result: Record<string, unknown> = {},
  errorMessage?: string,
): Promise<void> {
  const { error } = await db().from('project_deletion_steps').update({
    status,
    result: result as unknown as Json,
    error: errorMessage || null,
    completed_at: now(),
    updated_at: now(),
  }).eq('request_id', requestId).eq('step_name', step)
  if (error) throw new Error(`finishDeletionStep: ${error.message}`)
}

export async function setDeletionStatus(id: string, status: ProjectDeletionStatus, error?: string): Promise<void> {
  await updateProjectDeletionRequest(id, {
    status,
    error: error || null,
    ...(status === 'running' ? { started_at: now(), completed_at: null } : {}),
    ...(status === 'complete' ? { completed_at: now() } : {}),
  })
}
