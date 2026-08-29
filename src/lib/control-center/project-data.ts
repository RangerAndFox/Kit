/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAdminClient } from '@/lib/supabase/admin'
import type { ControlCenterProjectPayload } from './types'

type Row = Record<string, any>

function links(value: unknown): Array<{ label: string; url: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([label, raw]) => {
    const url = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && typeof (raw as any).url === 'string' ? (raw as any).url : ''
    return /^https:\/\//i.test(url) ? [{ label: label.replaceAll('_', ' '), url }] : []
  })
}

export async function loadControlCenterProject(workspaceId: string, projectId: string): Promise<ControlCenterProjectPayload | null> {
  const db = createAdminClient() as any
  const { data: project, error } = await db.from('projects').select('*').eq('workspace_id', workspaceId).eq('id', projectId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!project) return null
  const rows = async (query: PromiseLike<any>): Promise<Row[]> => {
    const result = await query
    if (result.error) throw new Error(result.error.message)
    return result.data || []
  }
  const [milestones, canvases, bindings, shares, creations, updates, archives, behance] = await Promise.all([
    rows(db.from('milestones').select('*').eq('project_id', projectId).order('due_date')),
    rows(db.from('project_control_canvases').select('*').eq('project_id', projectId).order('canvas_type')),
    rows(db.from('project_control_bindings').select('*').eq('project_id', projectId).limit(1)),
    rows(db.from('project_share_events').select('*').eq('project_id', projectId).order('created_at', { ascending: false }).limit(8)),
    rows(db.from('project_creation_requests').select('*').eq('workspace_id', workspaceId).eq('project_id', projectId).order('created_at', { ascending: false }).limit(5)),
    rows(db.from('project_update_requests').select('*').eq('workspace_id', workspaceId).eq('project_id', projectId).order('created_at', { ascending: false }).limit(8)),
    rows(db.from('archive_jobs').select('*').eq('workspace_id', workspaceId).eq('project_id', projectId).order('created_at', { ascending: false }).limit(5)),
    rows(db.from('behance_draft_jobs').select('*').eq('workspace_id', workspaceId).eq('project_id', projectId).order('created_at', { ascending: false }).limit(5)),
  ])
  const operations = [
    ...creations.map((row) => ({ id: `creation:${row.id}`, type: 'Provisioning', status: row.status, detail: row.error || 'Project creation workflow', at: row.updated_at || row.created_at })),
    ...updates.map((row) => ({ id: `update:${row.id}`, type: 'Project update', status: row.status, detail: row.error || 'Cross-system update', at: row.updated_at || row.created_at })),
    ...archives.map((row) => ({ id: `archive:${row.id}`, type: 'Archive', status: row.status, detail: row.error || 'Archive publishing workflow', at: row.updated_at || row.created_at })),
    ...behance.map((row) => ({ id: `behance:${row.id}`, type: 'Behance draft', status: row.status, detail: row.error || 'Private portfolio draft', at: row.updated_at || row.created_at })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 12)
  const retryable = behance.find((row) => ['failed', 'retryable'].includes(row.status))
  return {
    project: {
      id: project.id, code: project.project_code || '—', name: project.name, client: project.client || 'Internal', status: project.status || 'unknown',
      projectType: project.project_type || null, startDate: project.start_date || null, targetDelivery: project.target_delivery || null,
      brief: project.brief_summary || project.sow_summary || null, budgetTotal: project.budget_total == null ? null : Number(project.budget_total),
      budgetSpent: project.budget_spent == null ? null : Number(project.budget_spent), links: links(project.external_links),
    },
    milestones: milestones.map((row) => ({ id: row.id, name: row.name || row.title, dueDate: row.due_date, status: row.status || 'pending', completedAt: row.completed_at || null })),
    canvases: canvases.map((row) => ({ id: row.id, type: row.canvas_type, status: row.sync_status, url: row.canvas_url, lastSyncedAt: row.last_synced_at, error: row.error })),
    binding: bindings[0] ? { status: bindings[0].sync_status, creationState: bindings[0].creation_state, lastSyncedAt: bindings[0].last_synced_at, error: bindings[0].error } : null,
    shares: shares.map((row) => ({ id: row.id, fileName: row.file_name, status: row.status, url: row.share_url, createdAt: row.created_at })),
    operations,
    actions: { canReconcile: bindings.length > 0, retryableBehanceJobId: retryable?.id || null },
  }
}
