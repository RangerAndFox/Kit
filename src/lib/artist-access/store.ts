import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '../supabase/admin'
import type { Json } from '../../types/supabase'
import type { Engagement, Grant, OffboardRequest, OffboardSnapshot, OffboardStep, StepResult } from './types'

type Table<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] }
type Rpc = 'artist_access_begin' | 'artist_access_record' | 'artist_access_finish_onboarding' | 'artist_offboard_prepare' | 'artist_offboard_claim' | 'artist_offboard_checkpoint'
type AccessDatabase = { public: { Tables: { artist_project_engagements: Table<Engagement>; artist_offboarding_requests: Table<OffboardRequest> }; Views: Record<string, never>; Functions: Record<Rpc, { Args: Record<string, Json | undefined>; Returns: Json }> } }
export const accessDb = () => createAdminClient() as unknown as SupabaseClient<AccessDatabase>
export async function accessRpc<T>(name: Rpc, args: Record<string, Json | undefined>): Promise<T> {
  const { data, error } = await accessDb().rpc(name, args)
  if (error) throw new Error(`Access checkpoint unavailable (${error.code || 'unknown'}). No automatic re-grant; ask an administrator to review.`)
  const value = Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data
  if (value == null) throw new Error('Access checkpoint returned no result.')
  return value as T
}
export async function beginOnboarding(workspace: string, project: string, email: string, name: string, actor: string, legacy = false) {
  const owner = randomUUID()
  const engagement = await accessRpc<Engagement>('artist_access_begin', { p_workspace: workspace, p_project: project, p_email: email, p_name: name, p_actor: actor, p_owner: owner, p_legacy: legacy })
  return { engagement, owner }
}
export async function recordGrant(engagement: Engagement, owner: string, actor: string, service: 'slack' | 'dropbox' | 'frameio' | 'harvest', grant: Grant) {
  await accessRpc('artist_access_record', {p_workspace:engagement.workspace_id,p_id:engagement.id,p_owner:owner,p_actor:actor,p_service:service,p_grant:grant as unknown as Json})
}
export async function finishOnboarding(engagement: Engagement, owner: string, actor: string) {
  await accessRpc('artist_access_finish_onboarding',{p_workspace:engagement.workspace_id,p_id:engagement.id,p_owner:owner,p_actor:actor})
}
export async function prepareOffboarding(snapshot: OffboardSnapshot, actor: string): Promise<OffboardRequest> {
  return accessRpc('artist_offboard_prepare',{p_workspace:snapshot.engagement.workspace_id,p_id:snapshot.engagement.id,p_actor:actor,p_snapshot:snapshot as unknown as Json})
}
export async function readOffboarding(id: string, workspace: string, actor: string): Promise<OffboardRequest> {
  const {data,error} = await accessDb().from('artist_offboarding_requests').select('*').eq('id',id).eq('workspace_id',workspace).eq('actor',actor).maybeSingle()
  if (error || !data) throw new Error('This offboarding request is unavailable.')
  return data
}
export async function claimOffboarding(request: OffboardRequest, owner: string, cancel = false): Promise<OffboardRequest> {
  return accessRpc('artist_offboard_claim',{p_workspace:request.workspace_id,p_id:request.id,p_actor:request.actor,p_owner:owner,p_cancel:cancel})
}
export async function checkpoint(request: OffboardRequest, owner: string, step?: OffboardStep, result?: StepResult, finish = false): Promise<void> {
  await accessRpc('artist_offboard_checkpoint',{p_workspace:request.workspace_id,p_id:request.id,p_actor:request.actor,p_owner:owner,p_step:step || null,p_result:result ? result as unknown as Json : null,p_finish:finish})
}
