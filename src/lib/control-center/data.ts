/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminClient } from '@/lib/supabase/admin'
import { runAllChecks } from '@/lib/health/run'
import type {
  ActivityItem,
  AttentionItem,
  ControlCenterPayload,
  HealthCheck,
  ProjectSummary,
  QueueSummary,
  ReliabilityDay,
  Signal,
  WorkerSummary,
} from './types'

const ACTIVE_PROJECT_STATUSES = new Set(['active', 'in_progress', 'planning', 'in_review', 'on_hold'])
const TERMINAL_PROJECT_STATUSES = new Set(['wrapped', 'completed', 'archived'])
const DAY_MS = 86_400_000

type Row = Record<string, any>

function studioDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Detroit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

function isRecent(value: string | null | undefined, days = 7): boolean {
  if (!value) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp >= Date.now() - days * DAY_MS
}

function minDate(rows: Row[], field = 'created_at'): string | null {
  let oldest: string | null = null
  for (const row of rows) {
    const value = row[field]
    if (value && (!oldest || value < oldest)) oldest = value
  }
  return oldest
}

async function safeRows(promise: PromiseLike<any>, label: string): Promise<Row[]> {
  try {
    const { data, error } = await promise
    if (error) {
      throw new Error(`${label} unavailable: ${error.message}`)
    }
    return Array.isArray(data) ? data : []
  } catch (error: any) {
    console.error(`[control-center] ${label} unavailable`)
    throw error instanceof Error ? error : new Error(`${label} unavailable`)
  }
}

function projectSignal(row: Row): Signal {
  if (row.status === 'on_hold') return 'warning'
  if (row.target_delivery && Date.parse(row.target_delivery) < Date.now() && !TERMINAL_PROJECT_STATUSES.has(row.status)) {
    return 'danger'
  }
  if (row.updated_at && Date.parse(row.updated_at) < Date.now() - 21 * DAY_MS) return 'warning'
  return 'healthy'
}

function queue(
  key: string,
  label: string,
  rows: Row[],
  dangerStatuses: Set<string>,
  warningStatuses: Set<string> = new Set(),
): QueueSummary {
  const hasDanger = rows.some((row) => dangerStatuses.has(row.status || row.sync_status || row.creation_state))
  const hasWarning = rows.some((row) => warningStatuses.has(row.status || row.sync_status || row.creation_state))
  return {
    key,
    label,
    count: rows.length,
    oldestAt: minDate(rows),
    signal: hasDanger ? 'danger' : hasWarning || rows.length > 0 ? 'warning' : 'healthy',
  }
}

function parseHours(rows: Row[]): number {
  let hours = 0
  for (const row of rows) {
    if (row.status !== 'logged') continue
    for (const entry of Array.isArray(row.parsed_entries) ? row.parsed_entries : []) {
      const value = Number(entry?.hours)
      if (Number.isFinite(value) && value > 0) hours += value
    }
  }
  return Math.round(hours * 10) / 10
}

function activity(
  id: string,
  title: string,
  detail: string,
  at: string | null | undefined,
  signal: Signal = 'healthy',
  href?: string,
): ActivityItem | null {
  return at ? { id, title, detail, at, signal, href } : null
}

function countByDay(rows: Row[], dateField: string, failedStatuses: Set<string>): ReliabilityDay[] {
  const result: ReliabilityDay[] = []
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * DAY_MS)
    const key = studioDate(date)
    const dayRows = rows.filter((row) => row[dateField] && studioDate(new Date(row[dateField])) === key)
    result.push({
      date: key,
      label: new Intl.DateTimeFormat('en-US', { timeZone: 'America/Detroit', weekday: 'short' }).format(date),
      successful: dayRows.filter((row) => !failedStatuses.has(row.status)).length,
      failed: dayRows.filter((row) => failedStatuses.has(row.status)).length,
    })
  }
  return result
}

export async function loadControlCenterData(args: {
  workspaceId: string
  workspaceName: string
  displayName: string
  role: string
}): Promise<ControlCenterPayload> {
  const admin = createAdminClient() as any
  const sinceSevenDays = daysAgo(7)
  const projects = await safeRows(
    admin
      .from('projects')
      .select('id, project_code, name, client, status, target_delivery, updated_at, created_at')
      .eq('workspace_id', args.workspaceId)
      .order('updated_at', { ascending: false }),
    'projects',
  )
  const projectIds = projects.map((row) => row.id)

  const workspaceQuery = (table: string) => admin.from(table).select('*').eq('workspace_id', args.workspaceId)
  const projectQuery = (table: string) =>
    projectIds.length ? admin.from(table).select('*').in('project_id', projectIds) : Promise.resolve({ data: [], error: null })

  const [
    checks,
    healthState,
    cronHeartbeats,
    checkins,
    creationRequests,
    updateRequests,
    canvases,
    shareEvents,
    renderJobs,
    renderWorkers,
    archiveJobs,
    behanceJobs,
    behanceWorkers,
    elevenLabsJobs,
    elevenLabsWorkers,
    meetingBriefings,
    transcripts,
    transcriptDocuments,
    storyboards,
    agentRuns,
    accessibilityJobs,
  ] = await Promise.all([
    runAllChecks(),
    safeRows(admin.from('system_health').select('*'), 'system health'),
    safeRows(admin.from('cron_heartbeats').select('*'), 'cron heartbeats'),
    safeRows(admin.from('daily_hours_checkins').select('*').gte('check_in_date', studioDate(new Date(Date.now() - 14 * DAY_MS))), 'hours'),
    safeRows(workspaceQuery('project_creation_requests').gte('created_at', daysAgo(30)), 'project creation'),
    safeRows(workspaceQuery('project_update_requests').gte('created_at', daysAgo(30)), 'project updates'),
    safeRows(projectQuery('project_control_canvases'), 'canvases'),
    safeRows(projectQuery('project_share_events'), 'project shares'),
    safeRows(admin.from('render_jobs').select('*').gte('created_at', daysAgo(30)), 'render jobs'),
    safeRows(admin.from('render_workers').select('*'), 'render workers'),
    safeRows(workspaceQuery('archive_jobs').gte('created_at', daysAgo(30)), 'archive jobs'),
    safeRows(workspaceQuery('behance_draft_jobs').gte('created_at', daysAgo(30)), 'behance jobs'),
    safeRows(admin.from('behance_workers').select('*'), 'behance workers'),
    safeRows(workspaceQuery('elevenlabs_studio_jobs').gte('created_at', daysAgo(30)), 'ElevenLabs jobs'),
    safeRows(admin.from('elevenlabs_workers').select('*'), 'ElevenLabs workers'),
    safeRows(admin.from('meeting_briefings').select('*').gte('created_at', sinceSevenDays), 'meeting briefings'),
    safeRows(admin.from('call_transcripts').select('id, source, created_at, ingest_status, ingest_error').eq('workspace_id', args.workspaceId).gte('created_at', sinceSevenDays), 'transcripts'),
    safeRows(admin.from('project_documents').select('id, doc_type, visibility_tier, metadata, created_at').eq('workspace_id', args.workspaceId).eq('doc_type', 'call_transcript'), 'transcript privacy'),
    safeRows(workspaceQuery('storyboard_jobs').gte('created_at', daysAgo(30)), 'storyboards'),
    safeRows(workspaceQuery('agent_runs').gte('started_at', sinceSevenDays), 'agent runs'),
    safeRows(admin.from('accessibility_jobs').select('whisper_cost_cents, vision_cost_cents, elevenlabs_cost_cents, created_at').gte('created_at', daysAgo(30)), 'accessibility costs'),
  ])

  const persistedChecks: HealthCheck[] = healthState.map((row) => ({
    key: row.key,
    label: row.key,
    ok: row.status === 'up',
    detail: row.detail || undefined,
  }))
  const resolvedChecks: HealthCheck[] = checks.length ? checks : persistedChecks
  const integrations = resolvedChecks.filter((check) => !check.key.startsWith('cron:'))
  const automations = resolvedChecks.filter((check) => check.key.startsWith('cron:'))

  // Include heartbeats that are recorded but not yet part of the probe registry.
  const knownCronKeys = new Set(automations.map((check) => check.key.replace(/^cron:/, '')))
  for (const heartbeat of cronHeartbeats) {
    if (knownCronKeys.has(heartbeat.cron_id)) continue
    automations.push({
      key: `cron:${heartbeat.cron_id}`,
      label: heartbeat.cron_id.replaceAll('-', ' '),
      ok: isRecent(heartbeat.last_success_at, 1),
      detail: heartbeat.last_success_at ? `last success ${heartbeat.last_success_at}` : 'no heartbeat',
    })
  }

  const activeProjects = projects.filter((row) => ACTIVE_PROJECT_STATUSES.has(row.status))
  const projectMap = new Map(projects.map((row) => [row.id, row]))
  const openCreations = creationRequests.filter((row) => !['completed', 'cancelled'].includes(row.status))
  const openUpdates = updateRequests.filter((row) => !['completed', 'cancelled'].includes(row.status))
  const openCanvases = canvases.filter((row) => row.sync_status !== 'synced')
  const openShares = shareEvents.filter((row) => ['pending', 'applying'].includes(row.status))
  const openRenders = renderJobs.filter((row) => !['complete', 'cancelled'].includes(row.status))
  const openArchives = archiveJobs.filter((row) => !['complete', 'cancelled'].includes(row.status))
  const openBehance = behanceJobs.filter((row) => !['awaiting_review', 'cancelled'].includes(row.status))
  const openElevenLabs = elevenLabsJobs.filter((row) => !['complete', 'cancelled'].includes(row.status))
  // A sent/nudged DM with no reply is not a time entry waiting for
  // confirmation: Kit has no hours to log yet. Keep those rows available for
  // reminder telemetry, but do not turn ordinary non-replies into an operator
  // queue or a Control Center warning. Only rows with parsed hours (or an
  // actual logging failure) are actionable here.
  const openHours = checkins.filter((row) => ['parsed', 'failed', 'logging'].includes(row.status))

  const queues: QueueSummary[] = [
    queue('provisioning', 'Project provisioning', openCreations, new Set(['error'])),
    queue('updates', 'Project updates', openUpdates, new Set(['error', 'needs_attention'])),
    queue('canvases', 'Canvas synchronization', openCanvases, new Set(['error', 'orphaned'])),
    queue('shares', 'Frame.io shares', openShares, new Set(), new Set(['pending', 'applying'])),
    queue('renders', 'Render jobs', openRenders, new Set(['failed'])),
    queue('archives', 'Archive publishing', openArchives, new Set(['failed', 'partial'])),
    queue('behance', 'Behance drafts', openBehance, new Set(['failed']), new Set(['retryable', 'needs_login'])),
    queue('elevenlabs', 'ElevenLabs drafts', openElevenLabs, new Set(['failed']), new Set(['queued', 'retryable'])),
    queue('hours', 'Time confirmations', openHours, new Set(['failed', 'logging']), new Set(['parsed'])),
  ]

  const attention: AttentionItem[] = []
  for (const check of resolvedChecks.filter((item) => !item.ok)) {
    attention.push({
      id: `health:${check.key}`,
      title: `${check.label} is failing`,
      detail: check.detail || 'Kit could not complete this health check.',
      signal: 'danger',
      href: '/status',
    })
  }
  for (const row of openUpdates.filter((item) => ['error', 'needs_attention'].includes(item.status))) {
    const project = projectMap.get(row.project_id)
    attention.push({
      id: `update:${row.id}`,
      title: `${project?.project_code || project?.name || 'Project'} update needs attention`,
      detail: row.error || `Update is ${row.status.replaceAll('_', ' ')}.`,
      signal: 'danger',
      timestamp: row.updated_at,
    })
  }
  for (const row of openCanvases.filter((item) => ['error', 'orphaned'].includes(item.sync_status))) {
    const project = projectMap.get(row.project_id)
    attention.push({
      id: `canvas:${row.id}`,
      title: `${project?.project_code || 'Project'} ${row.canvas_type} Canvas is not synchronized`,
      detail: row.error || `Canvas is ${row.sync_status}.`,
      signal: 'danger',
      timestamp: row.updated_at,
    })
  }
  for (const row of openHours.filter((item) => ['failed', 'logging'].includes(item.status))) {
    attention.push({
      id: `hours:${row.id}`,
      title: row.status === 'logging' ? 'Time entry is stuck logging' : 'Time entry failed',
      detail: row.error_message || `Check-in for ${row.check_in_date} needs review.`,
      signal: 'danger',
      timestamp: row.updated_at,
    })
  }
  const awaitingHours = openHours.filter((row) => row.status === 'parsed')
  if (awaitingHours.length) {
    attention.push({
      id: 'hours:awaiting',
      title: `${awaitingHours.length} time ${awaitingHours.length === 1 ? 'entry is' : 'entries are'} awaiting confirmation`,
      detail: `Oldest open check-in is ${minDate(awaitingHours, 'check_in_date') || 'unknown'}.`,
      signal: 'warning',
    })
  }
  for (const row of activeProjects.filter((item) => projectSignal(item) === 'danger').slice(0, 4)) {
    attention.push({
      id: `project:${row.id}`,
      title: `${row.project_code || row.name} is past its target delivery`,
      detail: `${row.client || 'Project'} · target ${row.target_delivery}`,
      signal: 'warning',
      href: `/projects/${row.id}`,
      timestamp: row.target_delivery,
    })
  }

  const workers: WorkerSummary[] = [
    ...renderWorkers.map((row): WorkerSummary => {
      const stale = !row.last_heartbeat || Date.parse(row.last_heartbeat) < Date.now() - 5 * 60_000
      const status = stale ? 'offline' : row.status
      return {
        id: `render:${row.id}`,
        label: row.display_name || row.hostname || 'Render worker',
        type: 'Render',
        status,
        lastSeenAt: row.last_heartbeat,
        currentJob: row.current_job_id,
        detail: row.progress_message || (row.disk_free_gb != null ? `${Math.round(row.disk_free_gb)} GB free` : null),
        signal: status === 'online' || status === 'busy' ? 'healthy' : status === 'opted_out' ? 'warning' : 'danger',
      }
    }),
    ...behanceWorkers.map((row): WorkerSummary => {
      const stale = !row.last_seen_at || Date.parse(row.last_seen_at) < Date.now() - 3 * 60_000
      const status = stale ? 'offline' : row.status
      return {
        id: `behance:${row.worker_id}`,
        label: row.display_name || row.worker_id || 'Behance worker',
        type: 'Behance',
        status,
        lastSeenAt: row.last_seen_at,
        currentJob: row.current_job_id,
        detail: row.last_error || (row.browser_version ? `Chrome ${row.browser_version}` : null),
        signal: status === 'idle' || status === 'working' ? 'healthy' : status === 'needs_login' ? 'warning' : 'danger',
      }
    }),
    ...elevenLabsWorkers.map((row): WorkerSummary => {
      const stale = !row.last_seen_at || Date.parse(row.last_seen_at) < Date.now() - 3 * 60_000
      const status = stale ? 'offline' : row.status
      return {
        id: `elevenlabs:${row.worker_id}`,
        label: row.display_name || row.worker_id || 'ElevenLabs worker',
        type: 'ElevenLabs',
        status,
        lastSeenAt: row.last_seen_at,
        currentJob: row.current_job_id,
        detail: row.last_error || (row.browser_version ? `Chrome ${row.browser_version}` : null),
        signal: status === 'idle' || status === 'working' ? 'healthy' : status === 'needs_login' ? 'warning' : 'danger',
      }
    }),
  ]
  for (const worker of workers.filter((item) => item.signal === 'danger')) {
    attention.push({
      id: worker.id,
      title: `${worker.label} is ${worker.status.replaceAll('_', ' ')}`,
      detail: worker.detail || `Last seen ${worker.lastSeenAt || 'never'}.`,
      signal: 'danger',
      timestamp: worker.lastSeenAt || undefined,
    })
  }

  const today = studioDate()
  const loggedRows = checkins.filter((row) => row.status === 'logged')
  const loggedToday = loggedRows.filter((row) => row.check_in_date === today).length
  const hoursSevenDays = parseHours(loggedRows.filter((row) => row.check_in_date >= studioDate(new Date(Date.now() - 6 * DAY_MS))))
  const transcriptRows = transcripts.filter((row) => isRecent(row.created_at))
  const leakedTranscriptRows = transcriptDocuments.filter((row) => {
    const metadata = row.metadata || {}
    return ['plaud', 'drive'].includes(metadata.source) && row.visibility_tier !== 'founder'
  })

  const completedSevenDays =
    creationRequests.filter((row) => row.status === 'completed' && isRecent(row.updated_at)).length +
    updateRequests.filter((row) => row.status === 'completed' && isRecent(row.updated_at)).length +
    shareEvents.filter((row) => row.status === 'applied' && isRecent(row.updated_at)).length +
    meetingBriefings.filter((row) => row.status === 'sent' && isRecent(row.updated_at)).length +
    storyboards.filter((row) => row.status === 'complete' && isRecent(row.updated_at)).length +
    archiveJobs.filter((row) => row.status === 'complete' && isRecent(row.completed_at || row.updated_at)).length

  const recentActivity = [
    ...projects.map((row) => activity(`project:${row.id}`, `Project ${row.project_code || row.name} created`, `${row.client || 'Internal'} · ${row.name}`, row.created_at)),
    ...updateRequests.filter((row) => row.status === 'completed').map((row) => {
      const project = projectMap.get(row.project_id)
      return activity(`update:${row.id}`, `${project?.project_code || 'Project'} updated`, 'Project details were synchronized across connected systems.', row.updated_at)
    }),
    ...shareEvents.filter((row) => row.status === 'applied').map((row) => {
      const project = projectMap.get(row.project_id)
      return activity(`share:${row.id}`, `${project?.project_code || 'Project'} share processed`, row.file_name || 'Latest Client Progress share updated.', row.updated_at)
    }),
    ...meetingBriefings.filter((row) => row.status === 'sent').map((row) => activity(`brief:${row.id}`, 'Meeting briefing delivered', row.meeting_title || 'Upcoming meeting', row.updated_at)),
    ...storyboards.filter((row) => row.status === 'complete').map((row) => activity(`storyboard:${row.id}`, 'Storyboard completed', row.project_name, row.updated_at)),
    ...archiveJobs.filter((row) => row.status === 'complete').map((row) => {
      const project = projectMap.get(row.project_id)
      return activity(`archive:${row.id}`, `${project?.project_code || 'Project'} archive prepared`, 'Approved archive destinations completed.', row.completed_at || row.updated_at)
    }),
    ...behanceJobs.filter((row) => row.status === 'awaiting_review').map((row) => {
      const project = projectMap.get(row.project_id)
      return activity(`behance:${row.id}`, `${project?.project_code || 'Project'} Behance draft ready`, 'Draft saved privately and is awaiting human review.', row.completed_at || row.updated_at)
    }),
    ...elevenLabsJobs.filter((row) => row.status === 'complete').map((row) =>
      activity(
        `elevenlabs:${row.id}`,
        `${row.project_name} VO draft ready`,
        'Private ElevenLabs Studio draft created; no audio generated.',
        row.completed_at || row.updated_at,
        'healthy',
        row.studio_url || undefined,
      )),
  ]
    .filter((item): item is ActivityItem => item !== null)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 12)

  const reliabilityRows = [
    ...creationRequests,
    ...updateRequests,
    ...renderJobs,
    ...archiveJobs,
    ...behanceJobs,
    ...elevenLabsJobs,
    ...meetingBriefings,
    ...storyboards,
    ...agentRuns.map((row) => ({ ...row, created_at: row.started_at })),
  ].filter((row) => isRecent(row.created_at))
  const reliability = countByDay(reliabilityRows, 'created_at', new Set(['error', 'failed', 'needs_attention', 'partial']))

  const projectSummaries: ProjectSummary[] = activeProjects
    .map((row) => ({
      id: row.id,
      code: row.project_code || '—',
      name: row.name,
      client: row.client || 'Internal',
      status: row.status || 'unknown',
      phase: null,
      targetDelivery: row.target_delivery || null,
      updatedAt: row.updated_at || null,
      signal: projectSignal(row),
    }))
    .sort((a, b) => {
      const rank = { danger: 0, warning: 1, healthy: 2, neutral: 3 }
      return rank[a.signal] - rank[b.signal] || String(a.targetDelivery || '9999').localeCompare(String(b.targetDelivery || '9999'))
    })
    .slice(0, 10)

  const anyDanger = attention.some((item) => item.signal === 'danger')
  const overall = anyDanger ? 'incident' : attention.length ? 'attention' : 'operational'
  const cost = (field: string) => accessibilityJobs.reduce((sum, row) => sum + Math.max(0, Number(row[field]) || 0), 0)
  const whisperCost = cost('whisper_cost_cents')
  const visionCost = cost('vision_cost_cents')
  const elevenLabsCost = cost('elevenlabs_cost_cents')
  const webRevision = process.env.VERCEL_GIT_COMMIT_SHA || process.env.KIT_RELEASE_SHA || null
  const botCheck = integrations.find((check) => /slack|bolt|railway/i.test(`${check.key} ${check.label}`))
  const behanceWorker = workers.find((worker) => worker.type === 'Behance')

  return {
    generatedAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
    workspace: { id: args.workspaceId, name: args.workspaceName },
    viewer: { displayName: args.displayName, role: args.role },
    overall,
    summary: {
      activeProjects: activeProjects.length,
      attentionCount: attention.length,
      healthyAutomations: automations.filter((item) => item.ok).length,
      totalAutomations: automations.length,
      completedSevenDays,
    },
    integrations,
    automations,
    attention: attention.slice(0, 12),
    queues,
    workers,
    projects: projectSummaries,
    usage: [
      { key: 'projects', label: 'Projects created', value: projects.filter((row) => isRecent(row.created_at)).length, detail: 'last 7 days' },
      { key: 'shares', label: 'Frame.io shares', value: shareEvents.filter((row) => isRecent(row.created_at)).length, detail: 'detected in Client Progress or Delivery' },
      { key: 'canvases', label: 'Canvases refreshed', value: canvases.filter((row) => isRecent(row.last_synced_at)).length, detail: 'last successful synchronization' },
      { key: 'briefings', label: 'Briefings delivered', value: meetingBriefings.filter((row) => row.status === 'sent').length, detail: 'last 7 days' },
      { key: 'transcripts', label: 'Transcripts ingested', value: transcriptRows.length, detail: 'Plaud and approved sources' },
      { key: 'storyboards', label: 'Storyboards created', value: storyboards.filter((row) => row.status === 'complete' && isRecent(row.updated_at)).length, detail: 'last 7 days' },
      { key: 'archives', label: 'Projects archived', value: archiveJobs.filter((row) => row.status === 'complete' && isRecent(row.completed_at || row.updated_at)).length, detail: 'publishing workflows completed' },
      { key: 'hours', label: 'Hours logged', value: hoursSevenDays, suffix: 'h', detail: 'last 7 days' },
    ],
    costs: {
      trackedCentsThirtyDays: whisperCost + visionCost + elevenLabsCost,
      byProvider: [
        { key: 'whisper', label: 'Whisper', cents: whisperCost },
        { key: 'vision', label: 'Vision', cents: visionCost },
        { key: 'elevenlabs', label: 'ElevenLabs', cents: elevenLabsCost },
      ],
      coverage: [
        { label: 'Accessibility AI', tracked: true, detail: 'Whisper, vision and ElevenLabs costs are stored per job.' },
        { label: 'Anthropic', tracked: false, detail: 'Calls work, but token usage is not yet written to Kit’s ledger.' },
        { label: 'OpenAI embeddings', tracked: false, detail: 'Calls work, but embedding usage is not yet written to Kit’s ledger.' },
        { label: 'Infrastructure', tracked: false, detail: 'Vercel, Railway and Supabase billing are not connected to Kit.' },
      ],
    },
    releases: [
      {
        key: 'web', label: 'Control Center', provider: 'Vercel', revision: webRevision ? webRevision.slice(0, 7) : null,
        environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
        detail: process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'Current web deployment', signal: 'healthy',
      },
      {
        key: 'bot', label: 'Slack bot', provider: 'Railway', revision: null, environment: 'production',
        detail: botCheck ? (botCheck.ok ? 'Live health check passing; revision not reported.' : botCheck.detail || 'Health check failing.') : 'Revision is not reported to the dashboard yet.',
        signal: botCheck ? (botCheck.ok ? 'healthy' : 'danger') : 'warning',
      },
      {
        key: 'behance', label: 'Behance worker', provider: 'Studio Mac', revision: null, environment: 'dedicated worker',
        detail: behanceWorker?.detail || (behanceWorker ? `Heartbeat ${behanceWorker.status}` : 'No heartbeat received yet.'),
        signal: behanceWorker?.signal || 'warning',
      },
    ],
    timeLogging: {
      loggedToday,
      hoursSevenDays,
      awaitingConfirmation: openHours.filter((row) => row.status === 'parsed').length,
      needsClarification: openHours.filter((row) => row.status === 'parsed' && Array.isArray(row.parsed_entries) && row.parsed_entries.some((entry: any) => entry?.resolution !== 'matched')).length,
      failed: openHours.filter((row) => row.status === 'failed').length,
      stuck: openHours.filter((row) => row.status === 'logging').length,
    },
    reliability,
    recentActivity,
    safeguards: {
      plaudEnabled: process.env.PLAUD_INGEST_ENABLED === 'true',
      transcriptCountSevenDays: transcriptRows.length,
      sharedTranscriptLeakCount: leakedTranscriptRows.length,
      serviceRoleServerOnly: !process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY,
    },
  }
}
