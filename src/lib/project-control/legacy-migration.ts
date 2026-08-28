/**
 * One-time, idempotent cutover from the original RF production workbook and
 * existing Slack project channels into the Canvas Control Center.
 *
 * Source precedence:
 *   1. original production workbook (producer-entered project details)
 *   2. existing Control Center row (normalized fields not present upstream)
 *   3. the active Supabase project record (provider links + legacy-only rows)
 *   4. Slack channel topic/name (identity fallback only)
 *
 * Slack is the existence boundary: this migration binds only live channels.
 * Obvious tests are quarantined, and ambiguous spreadsheet rows fail closed.
 */

import { randomUUID } from 'node:crypto'
import { createAdminClient } from '../supabase/admin'
import { bindProjectControl } from './creation'
import {
  adoptLegacyProjectRow,
  deleteProjectRowMetadata,
  readSpreadsheetValues,
  type LegacyProjectRowSeed,
} from './sheets'
import { workbookConfigFromEnv } from './types'
import {
  claimWorkbookLease,
  getBindingByProject,
  listProjectCanvases,
  releaseWorkbookLease,
  renewWorkbookLease,
} from './store'

const SLACK_API = 'https://slack.com/api'
const PROJECT_CHANNEL_RE = /^(\d{4}[a-z]?)(?:-|_)/i
const TEST_RE = /(?:^|[-_\s])(test|testing|delete[-_\s]*me|sandbox|dummy|sample)(?:$|[-_\s])/i

interface SlackChannel {
  id: string
  name: string
  topic?: { value?: string }
  purpose?: { value?: string }
  is_archived?: boolean
  is_private?: boolean
  is_member?: boolean
}

interface SlackResponse {
  ok?: boolean
  error?: string
  channels?: SlackChannel[]
  response_metadata?: { next_cursor?: string }
}

interface ProjectRow {
  id: string
  workspace_id: string
  project_code: string | null
  name: string | null
  client: string | null
  project_type: string | null
  status: string | null
  start_date: string | null
  target_delivery: string | null
  slack_channel_id: string | null
  external_links: Record<string, unknown> | null
  external_ids?: Record<string, unknown> | null
  created_at?: string | null
}

export interface LegacyMigrationResult {
  ran: boolean
  scannedChannels: number
  eligible: number
  connected: string[]
  deferred: string[]
  skipped: Array<{ projectNumber?: string; channel: string; reason: string }>
  errors: Array<{ projectNumber?: string; channel: string; error: string }>
}

async function slackCall(method: string, payload: Record<string, unknown>): Promise<SlackResponse> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set')
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  })
  const json = await res.json() as SlackResponse
  if (!json.ok) throw new Error(`Slack ${method}: ${json.error || res.status}`)
  return json
}

async function listLiveProjectChannels(): Promise<SlackChannel[]> {
  const out: SlackChannel[] = []
  let cursor = ''
  do {
    const page = await slackCall('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    out.push(...(page.channels || []))
    cursor = page.response_metadata?.next_cursor || ''
  } while (cursor)
  return out.filter((channel) => PROJECT_CHANNEL_RE.test(channel.name) && !channel.is_archived)
}

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function projectNumber(value: unknown): string | null {
  const match = clean(value).match(/^(\d{4}[a-z]?)(?:[-_]|$)/i)
  return match?.[1]?.toUpperCase() || null
}

function normalized(value: unknown): string {
  return clean(value).toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim()
}

function canonicalClient(value: unknown): string {
  const n = normalized(value)
  if (n === 'msft' || n === 'microsoft') return 'microsoft'
  if (n.includes('internal') || n === 'r f') return 'internal'
  return n
}

function overlaps(a: unknown, b: unknown): boolean {
  const aa = normalized(a)
  const bb = normalized(b)
  if (!aa || !bb) return false
  if (aa === bb || aa.includes(bb) || bb.includes(aa)) return true
  const left = new Set(aa.split(' ').filter((x) => x.length > 2))
  return bb.split(' ').some((x) => x.length > 2 && left.has(x))
}

function parseIsoDate(value: unknown): string | undefined {
  const text = clean(value)
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const us = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/)
  if (!us) return undefined
  return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
}

function rowsByProjectNumber(values: Array<Array<string | number | boolean>>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const row of values) {
    const number = projectNumber(row[0])
    if (number) out.set(number, row.map(clean))
  }
  return out
}

function inferFromChannel(channel: SlackChannel): { client?: string; name?: string } {
  const topic = clean(channel.topic?.value).replace(/&amp;/g, '&')
  const topicParts = topic.split(/\s+[—–]\s+/)
  if (topicParts.length >= 2) return { client: topicParts[0], name: topicParts.slice(1).join(' — ') }
  const tail = channel.name.replace(PROJECT_CHANNEL_RE, '').replace(/[-_]+/g, ' ').trim()
  return { name: tail || undefined }
}

function lifecycleFrom(row: string[] | undefined, target: string[] | undefined, project: ProjectRow | null): string {
  if (clean(target?.[5])) return clean(target?.[5])
  const notes = `${clean(row?.[4])} ${clean(row?.[5])} ${clean(row?.[13])}`
  if (/completed|delivered/i.test(notes)) return 'Completed'
  if (project?.status && /archiv/i.test(project.status)) return 'Archived'
  return 'Active'
}

function buildSeed(
  number: string,
  source: string[] | undefined,
  target: string[] | undefined,
  project: ProjectRow | null,
  channel: SlackChannel,
): LegacyProjectRowSeed {
  const inferred = inferFromChannel(channel)
  const pick = (...values: unknown[]) => values.map(clean).find(Boolean)
  const sourceDelivery = parseIsoDate(source?.[7])
  return {
    projectNumber: number,
    client: pick(source?.[1], target?.[1], project?.client, inferred.client),
    projectName: pick(source?.[3], target?.[2], project?.name, inferred.name),
    clientContact: pick(source?.[10], source?.[2], target?.[3]),
    projectType: pick(source?.[12], target?.[4], project?.project_type),
    lifecycle: lifecycleFrom(source, target, project),
    phase: pick(source?.[4], target?.[6]),
    currentStatus: pick(source?.[5], target?.[7]),
    nextMilestone: pick(source?.[6], target?.[8]),
    startDate: parseIsoDate(source?.[11]) || parseIsoDate(target?.[10]) || project?.start_date || undefined,
    deliveryDate: sourceDelivery || parseIsoDate(target?.[11]) || project?.target_delivery || undefined,
    creativeDirector: pick(source?.[8], target?.[12]),
    producer: pick(source?.[9], target?.[13]),
    previousNotes: pick(source?.[13], target?.[19]),
  }
}

function scoreProject(candidate: ProjectRow, number: string, seed: LegacyProjectRowSeed, channelId: string): number {
  let score = 0
  if (candidate.slack_channel_id === channelId || candidate.external_links?.slack_id === channelId) score += 100
  if (clean(candidate.project_code).toUpperCase() === number) score += 2
  if (candidate.status === 'active') score += 2
  if (canonicalClient(candidate.client) && canonicalClient(candidate.client) === canonicalClient(seed.client)) score += 4
  if (normalized(candidate.name) && normalized(candidate.name) === normalized(seed.projectName)) score += 6
  else if (overlaps(candidate.name, seed.projectName)) score += 3
  return score
}

async function resolveProject(
  all: ProjectRow[],
  workspaceId: string,
  number: string,
  seed: LegacyProjectRowSeed,
  channel: SlackChannel,
): Promise<ProjectRow> {
  const candidates = all.filter((row) => projectNumber(row.project_code) === number)
  const ranked = candidates
    .map((row) => ({ row, score: scoreProject(row, number, seed, channel.id) }))
    .sort((a, b) => b.score - a.score)
  let chosen: ProjectRow | null = ranked[0]?.row ?? null
  // A code can have a genuinely different archived historical record (2520 is
  // both Icertis and the current Internal Espresso project). Never repurpose a
  // low-similarity row merely because the numeric code matches.
  if (chosen && (seed.client || seed.projectName) && (ranked[0]?.score || 0) < 5) chosen = null

  const sb = createAdminClient()
  const links = { ...(chosen?.external_links || {}), slack_id: channel.id, slack: `https://slack.com/app_redirect?channel=${channel.id}` }
  const patch = {
    workspace_id: workspaceId,
    name: seed.projectName || chosen?.name || number,
    client: seed.client || chosen?.client || 'Unknown',
    project_type: seed.projectType || chosen?.project_type || null,
    status: clean(seed.lifecycle).toLowerCase().replace(/\s+/g, '_') || chosen?.status || 'active',
    start_date: seed.startDate || chosen?.start_date || null,
    target_delivery: seed.deliveryDate || chosen?.target_delivery || null,
    slack_channel_id: channel.id,
    external_links: links,
  }
  if (chosen) {
    const { data, error } = await sb.from('projects').update(patch).eq('id', chosen.id).select('*').single()
    if (error) throw new Error(`project update ${number}: ${error.message}`)
    Object.assign(chosen, data)
    return chosen
  }

  const clientCode = (seed.client || 'Unknown').replace(/\s+/g, '')
  const { data, error } = await sb.from('projects').insert({
    ...patch,
    project_code: `${number}-${clientCode}`,
    external_ids: { project_number: number, migrated_from: 'legacy-production-sheet+slack' },
  }).select('*').single()
  if (error) throw new Error(`project insert ${number}: ${error.message}`)
  all.push(data as ProjectRow)
  return data as ProjectRow
}

function providerUrl(links: Record<string, unknown> | null | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = clean(links?.[key])
    if (/^https?:\/\//i.test(value)) return value
  }
  return undefined
}

async function ensureChannelAccess(channel: SlackChannel, projectId: string): Promise<void> {
  if (!channel.is_private && !channel.is_member) {
    await slackCall('conversations.join', { channel: channel.id })
    channel.is_member = true
  }
  const purpose = clean(channel.purpose?.value)
  if (/\[kit:undefined\]/i.test(purpose)) {
    try {
      await slackCall('conversations.setPurpose', {
        channel: channel.id,
        purpose: purpose.replace(/\[kit:undefined\]/ig, `[kit:${projectId}]`),
      })
    } catch (error) {
      // The marker repair is useful but not required for the durable Sheet +
      // database binding. Some older channels restrict purpose edits.
      console.warn(`[project-control migration] could not repair purpose for ${channel.name}:`, error)
    }
  }
}

async function removeMigrationDuplicates(
  config: NonNullable<ReturnType<typeof workbookConfigFromEnv>>,
  projects: ProjectRow[],
): Promise<void> {
  const groups = new Map<string, ProjectRow[]>()
  for (const project of projects) {
    if (project.external_ids?.migrated_from !== 'legacy-production-sheet+slack') continue
    const key = `${clean(project.project_code).toLowerCase()}|${clean(project.slack_channel_id)}`
    if (!project.slack_channel_id) continue
    groups.set(key, [...(groups.get(key) || []), project])
  }
  const sb = createAdminClient()
  for (const duplicates of groups.values()) {
    if (duplicates.length < 2) continue
    duplicates.sort((a, b) => clean(a.created_at).localeCompare(clean(b.created_at)))
    for (const duplicate of duplicates.slice(1)) {
      const canvases = await listProjectCanvases(duplicate.id)
      for (const canvas of canvases) {
        if (canvas.canvas_id) await slackCall('canvases.delete', { canvas_id: canvas.canvas_id })
      }
      await deleteProjectRowMetadata(config, duplicate.id)
      const { error } = await sb.from('projects').delete().eq('id', duplicate.id)
      if (error) throw new Error(`duplicate cleanup ${duplicate.project_code}: ${error.message}`)
      const index = projects.findIndex((candidate) => candidate.id === duplicate.id)
      if (index >= 0) projects.splice(index, 1)
      console.log(`[project-control migration] removed duplicate ${duplicate.project_code} (${duplicate.id})`)
    }
  }
}

export async function runLegacyProjectControlMigration(): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = {
    ran: false, scannedChannels: 0, eligible: 0, connected: [], deferred: [], skipped: [], errors: [],
  }
  if (process.env.PROJECT_CONTROL_LEGACY_MIGRATION_ENABLED !== 'true') return result
  const sourceSpreadsheetId = process.env.PROJECT_CONTROL_LEGACY_SPREADSHEET_ID?.trim()
  const config = workbookConfigFromEnv()
  if (!sourceSpreadsheetId || !config) throw new Error('legacy migration workbook configuration is incomplete')
  result.ran = true

  // A deploy and an environment-variable change can briefly overlap Railway
  // replicas. Hold the workbook sync lease for the entire cutover so only one
  // migration can inventory/adopt rows at a time.
  const migrationHolder = `legacy-migration:${randomUUID()}`
  if (!(await claimWorkbookLease(config.spreadsheetId, 'sync', migrationHolder))) {
    result.ran = false
    result.skipped.push({ channel: '*', reason: 'migration_lease_unavailable' })
    return result
  }

  try {

  const [channels, sourceValues, targetValues] = await Promise.all([
    listLiveProjectChannels(),
    readSpreadsheetValues(sourceSpreadsheetId, "'Projects'!A1:O200"),
    readSpreadsheetValues(config.spreadsheetId, "'Projects'!A1:W300"),
  ])
  result.scannedChannels = channels.length
  const sourceRows = rowsByProjectNumber(sourceValues)
  const targetRows = rowsByProjectNumber(targetValues)

  const sb = createAdminClient()
  const teamId = process.env.SLACK_TEAM_ID || 'T4ATY2XAL'
  const { data: workspace, error: workspaceError } = await sb.from('workspaces').select('id').eq('slack_team_id', teamId).single()
  if (workspaceError || !workspace?.id) throw new Error(`workspace lookup failed: ${workspaceError?.message || teamId}`)
  const { data: projectData, error: projectError } = await sb.from('projects').select('*').eq('workspace_id', workspace.id)
  if (projectError) throw new Error(`project inventory failed: ${projectError.message}`)
  const projects = (projectData || []) as ProjectRow[]
  await removeMigrationDuplicates(config, projects)
  const forceRender = process.env.PROJECT_CONTROL_LEGACY_MIGRATION_FORCE_RENDER === 'true'

  for (const channel of channels.sort((a, b) => a.name.localeCompare(b.name))) {
    const number = projectNumber(channel.name)
    if (!number) continue
    if (TEST_RE.test(channel.name)) {
      result.skipped.push({ projectNumber: number, channel: channel.name, reason: 'test_quarantined' })
      continue
    }
    const source = sourceRows.get(number)
    const target = targetRows.get(number)
    const candidates = projects.filter((row) => projectNumber(row.project_code) === number)
    const hasActiveProject = candidates.some((row) => row.status === 'active')
    if (!source && !target && !hasActiveProject) {
      result.skipped.push({ projectNumber: number, channel: channel.name, reason: 'no_current_sheet_or_active_project_match' })
      continue
    }
    result.eligible++
    try {
      if (!(await renewWorkbookLease(config.spreadsheetId, 'sync', migrationHolder))) {
        throw new Error('migration lease lost')
      }
      const provisional = buildSeed(number, source, target, candidates.find((row) => row.status === 'active') || candidates[0] || null, channel)
      const project = await resolveProject(projects, workspace.id, number, provisional, channel)
      const seed = buildSeed(number, source, target, project, channel)
      await ensureChannelAccess(channel, project.id)
      const existingBinding = await getBindingByProject(project.id)
      const existingCanvases = existingBinding?.creation_state === 'connected'
        ? await listProjectCanvases(project.id)
        : []
      if (!forceRender && existingBinding?.creation_state === 'connected' &&
          existingBinding.sync_status === 'synced' && existingCanvases.length >= 3) {
        result.connected.push(number)
        continue
      }
      await adoptLegacyProjectRow(config, project.id, seed)
      const links = project.external_links || {}
      const bind = await bindProjectControl({
        projectId: project.id,
        submission: {
          projectNumber: number,
          clientName: seed.client,
          clientContact: seed.clientContact,
          projectName: seed.projectName,
          initialStatus: seed.lifecycle,
          startDate: seed.startDate,
          deadline: seed.deliveryDate,
          creativeDirectorName: seed.creativeDirector,
          producerName: seed.producer,
          projectType: seed.projectType,
          frameioUrl: providerUrl(links, 'frameio_url', 'frameio'),
          dropboxUrl: providerUrl(links, 'dropbox_url', 'dropbox'),
          harvestUrl: providerUrl(links, 'harvest_url', 'harvest'),
          boordsUrl: providerUrl(links, 'boords_url', 'boords'),
        },
        slackResult: { id: channel.id, data: { channelId: channel.id } },
      })
      if (bind.status === 'connected') result.connected.push(number)
      else if (bind.status === 'deferred') result.deferred.push(number)
      else result.errors.push({ projectNumber: number, channel: channel.name, error: bind.reason || bind.status })
      // Stay below Google Sheets' service-account read quota. A new binding
      // renders three views and reads several normalized tabs.
      await new Promise((resolve) => setTimeout(resolve, 20_000))
    } catch (error) {
      result.errors.push({ projectNumber: number, channel: channel.name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
  } finally {
    await releaseWorkbookLease(config.spreadsheetId, 'sync', migrationHolder).catch(() => {})
  }
}
