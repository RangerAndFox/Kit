import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildWorldSnapshot, recordedState, safeDetail, slackReceipt } from './model'
import type { WorldSnapshot, WorldSource, WorldTask } from './types'

type Row = Record<string, unknown>
type Result = { data: unknown; error: unknown }
const LIMIT = 25
const text = (row: Row, key: string) => typeof row[key] === 'string' ? row[key] as string : ''
const terminal = '(complete,completed,cancelled,canceled,skipped,superseded,logged,synced,success)'
const PROVIDER_AGENTS: Record<string, string> = { dropbox: 'delivery', frameio: 'delivery', 'dropbox-inbox': 'delivery', 'delivery-notifications': 'delivery', google: 'production', 'control-outbox': 'production', harvest: 'finance' }
interface SourceSpec { id: string; agent: string; table: string; columns: string; status: string; order: string; scope: 'workspace' | 'project' | 'member' | 'studio'; history?: boolean }
export const WORLD_SOURCE_SPECS: readonly SourceSpec[] = [
  { id: 'runs', agent: 'kit', table: 'agent_runs', columns: 'id,run_type,status,error,started_at,completed_at', status: 'status', order: 'started_at', scope: 'workspace' },
  { id: 'run-history', agent: 'kit', table: 'agent_runs', columns: 'id,run_type,status,error,started_at,completed_at', status: 'status', order: 'started_at', scope: 'workspace', history: true },
  { id: 'uploads', agent: 'delivery', table: 'frame_upload_approvals', columns: 'id,project_id,state,source_path,detail,updated_at,slack_channel_id,slack_message_ts,collision_channel_id,collision_message_ts', status: 'state', order: 'updated_at', scope: 'workspace' },
  { id: 'upload-history', agent: 'delivery', table: 'frame_upload_approvals', columns: 'id,project_id,state,source_path,detail,updated_at,slack_channel_id,slack_message_ts', status: 'state', order: 'updated_at', scope: 'workspace', history: true },
  { id: 'creation', agent: 'production', table: 'project_creation_requests', columns: 'id,project_id,status,error,updated_at', status: 'status', order: 'updated_at', scope: 'workspace' },
  { id: 'updates', agent: 'production', table: 'project_update_requests', columns: 'id,project_id,status,error,updated_at', status: 'status', order: 'updated_at', scope: 'workspace' },
  { id: 'storyboards', agent: 'production', table: 'storyboard_jobs', columns: 'id,project_name,status,last_error,updated_at,channel_id', status: 'status', order: 'updated_at', scope: 'workspace' },
  { id: 'people', agent: 'people', table: 'freelancer_onboardings', columns: 'id,project_id,artist_name,slack_status,dropbox_status,frameio_status,harvest_status,welcome_dm_status,slack_error,dropbox_error,frameio_error,harvest_error,welcome_dm_error,updated_at', status: '', order: 'updated_at', scope: 'project' },
  { id: 'hours', agent: 'finance', table: 'daily_hours_checkins', columns: 'id,status,check_in_date,error_message,updated_at,dm_channel_id,dm_ts', status: 'status', order: 'updated_at', scope: 'member' },
  { id: 'archives', agent: 'archive', table: 'archive_jobs', columns: 'id,project_id,status,error,updated_at,slack_channel_id,slack_message_ts', status: 'status', order: 'updated_at', scope: 'workspace' },
  { id: 'behance', agent: 'archive', table: 'behance_draft_jobs', columns: 'id,project_id,status,error,updated_at', status: 'status', order: 'updated_at', scope: 'workspace' },
  { id: 'voice', agent: 'archive', table: 'elevenlabs_studio_jobs', columns: 'id,kit_project_id,project_name,status,error,updated_at,slack_channel_id,slack_thread_ts', status: 'status', order: 'updated_at', scope: 'workspace' },
]

/** Explicit columns only. Never read prompts, signed URLs, credentials, rates or
 * serialized provider payloads to draw a city. Each source is independently scoped. */
export async function loadWorkingWorld(args: { workspaceId: string; workspaceName: string }, client?: SupabaseClient): Promise<WorldSnapshot> {
  const db = client || createAdminClient() as unknown as SupabaseClient
  const observedAt = new Date().toISOString()
  const now = Date.parse(observedAt)
  const sources: WorldSource[] = []
  async function read(id: string, query: PromiseLike<Result>): Promise<Row[]> {
    try {
      const result = await query
      if (result.error || !Array.isArray(result.data)) throw new Error('Feed unavailable')
      sources.push({ id, available: true, checkedAt: observedAt, truncated: result.data.length > LIMIT })
      return result.data.slice(0, LIMIT) as Row[]
    } catch {
      console.error('[working-world] Source unavailable:', id)
      sources.push({ id, available: false, checkedAt: observedAt, truncated: false })
      return []
    }
  }
  // Membership is scoped before reading legacy tables without workspace_id.
  const [projectResult, memberResult, studioResult] = await Promise.all([
    db.from('projects').select('id,project_code,name').eq('workspace_id', args.workspaceId).order('id').limit(1001).abortSignal(AbortSignal.timeout(6000)),
    db.from('team_members').select('slack_user_id').eq('workspace_id', args.workspaceId).limit(1001).abortSignal(AbortSignal.timeout(6000)),
    db.from('workspaces').select('id,slack_team_id').limit(2).abortSignal(AbortSignal.timeout(6000)),
  ])
  const projects = !projectResult.error && Array.isArray(projectResult.data) ? projectResult.data as Row[] : null
  const members = !memberResult.error && Array.isArray(memberResult.data) ? memberResult.data as Row[] : null
  const projectScopeReady = !!projects && projects.length <= 1000
  const memberScopeReady = !!members && members.length <= 1000
  const projectIds = projectScopeReady ? projects.map(p => text(p, 'id')).filter(Boolean) : []
  const memberIds = memberScopeReady ? members.map(m => text(m, 'slack_user_id')).filter(Boolean) : []
  const projectMap = new Map((projects || []).map(p => [text(p, 'id'), `${text(p, 'project_code')} — ${text(p, 'name')}`]))
  const soleStudio = !studioResult.error && studioResult.data?.length === 1 && studioResult.data[0].id === args.workspaceId
  const slackTeam = studioResult.data?.find(row => row.id === args.workspaceId)?.slack_team_id
  const healthPromise = soleStudio ? read('health', db.from('system_health').select('key,status,detail,checked_at').in('key', Object.keys(PROVIDER_AGENTS)).order('key').limit(8).abortSignal(AbortSignal.timeout(6000))) : Promise.resolve([] as Row[])
  const results = await Promise.all(WORLD_SOURCE_SPECS.map(async spec => {
    if ((spec.scope === 'project' && !projectScopeReady) || (spec.scope === 'member' && !memberScopeReady)) {
      sources.push({ id: spec.id, available: false, checkedAt: observedAt, truncated: false }); return { spec, rows: [] as Row[] }
    }
    if ((spec.scope === 'project' && !projectIds.length) || (spec.scope === 'member' && !memberIds.length)) {
      sources.push({ id: spec.id, available: true, checkedAt: observedAt, truncated: false }); return { spec, rows: [] as Row[] }
    }
    let query = db.from(spec.table).select(spec.columns)
    if (spec.scope === 'workspace') query = query.eq('workspace_id', args.workspaceId)
    if (spec.scope === 'project') query = query.in('project_id', projectIds)
    if (spec.scope === 'member') query = query.in('slack_user_id', memberIds)
    if (spec.history) query = query.gte(spec.order, new Date(now - 2 * 86_400_000).toISOString())
    else if (spec.id === 'people') query = query.or('slack_status.in.(pending,failed),dropbox_status.in.(pending,failed),frameio_status.in.(pending,failed),harvest_status.in.(pending,failed),welcome_dm_status.in.(pending,failed)')
    else query = query.not(spec.status, 'in', terminal)
    const rows = await read(spec.id, query.order(spec.order, { ascending: false }).order('id').limit(LIMIT + 1).abortSignal(AbortSignal.timeout(6000)))
    return { spec, rows }
  }))
  const tasks = new Map<string, WorldTask>()
  for (const { spec, rows } of results) for (const row of rows) {
    const projectId = text(row, 'project_id') || text(row, 'kit_project_id')
    const scopedProject = projectIds.includes(projectId)
    let status = text(row, spec.status), detail = text(row, 'detail') || text(row, 'error') || text(row, 'last_error') || text(row, 'error_message')
    if (spec.id === 'people') {
      const services = ['slack', 'dropbox', 'frameio', 'harvest', 'welcome_dm']
      const failures = services.filter(s => row[`${s}_status`] === 'failed')
      status = failures.length ? 'failed' : services.some(s => row[`${s}_status`] === 'pending') ? 'pending' : 'complete'
      detail = failures.length ? failures.map(s => `${s}: ${text(row, `${s}_error`) || 'manual handoff needed'}`).join('; ') : 'Service invites are pending.'
    }
    const at = text(row, 'updated_at') || text(row, 'completed_at') || text(row, 'started_at') || null
    const state = recordedState(status, at, now)
    const agentId = spec.table === 'agent_runs' && /knowledge|brain|scavenge|transcript/i.test(text(row, 'run_type')) ? 'knowledge' : spec.agent
    const filename = text(row, 'source_path').split('/').pop()
    const title = filename || (spec.id === 'people' ? `Access: ${text(row, 'artist_name') || 'artist'}` : text(row, 'project_name')) || (spec.table === 'agent_runs' ? text(row, 'run_type') : spec.id.replaceAll('-', ' '))
    const href = slackReceipt(text(row, 'collision_channel_id') || text(row, 'slack_channel_id') || text(row, 'dm_channel_id'),
      text(row, 'collision_message_ts') || text(row, 'slack_message_ts') || text(row, 'slack_thread_ts') || text(row, 'dm_ts'), slackTeam) ||
      (scopedProject && /^[a-f0-9-]{36}$/.test(projectId) ? `/control-center/projects/${projectId}` : '/control-center')
    const id = `${spec.table}:${text(row, 'id')}`
    if (!tasks.has(id)) tasks.set(id, { id, agentId, title: safeDetail(title).slice(0, 160), state, recordedStatus: status,
      detail: safeDetail(detail || (state === 'unknown' ? 'The job status or progress timestamp is not current enough to confirm activity.' : `Recorded status: ${status}.`)),
      at, href, project: projectMap.get(projectId) || null, source: spec.id })
  }
  // Existing health/cron tables describe a single studio. Never expose them to
  // an arbitrary workspace after the first multi-tenant configuration appears.
  const healthRows = await healthPromise
  if (!soleStudio) sources.push({ id: 'health', available: false, checkedAt: observedAt, truncated: false })
  const health = healthRows.flatMap(row => {
    const key = text(row, 'key')
    const agentId = PROVIDER_AGENTS[key]
    if (!agentId) return []
    const at = text(row, 'checked_at') || null
    const fresh = at && Date.parse(at) <= now + 60_000 && now - Date.parse(at) < 20 * 60_000
    const state = !fresh || text(row, 'status') === 'unknown' ? 'unknown' as const : text(row, 'status') === 'down' ? 'blocked' as const : 'idle' as const
    return [{ agentId, state, detail: fresh ? `${key}: ${safeDetail(row.detail) || text(row, 'status')}` : `${key}: provider health evidence is stale.`, at }]
  })
  if (sources.find(s => s.id === 'health')?.available) for (const [key, agentId] of Object.entries(PROVIDER_AGENTS)) {
    if (!healthRows.some(row => row.key === key)) health.push({ agentId, state: 'unknown', detail: `${key}: no provider health evidence is recorded.`, at: null })
  }
  if (!sources.find(s => s.id === 'health')?.available) for (const agentId of ['delivery', 'production', 'finance']) health.push({ agentId, state: 'unknown', detail: 'Provider health feed unavailable.', at: null })
  return buildWorldSnapshot({ workspaceName: args.workspaceName, observedAt, tasks: [...tasks.values()], sources, health })
}
