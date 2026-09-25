/**
 * Dropbox new-file detection for the delivery pipeline.
 *
 * Polls /Delivery-Queue/ (and subfolders, but excludes /delivery/ outputs).
 * Tracks seen file ids in `seen_dropbox_files` so we only notify once per file.
 *
 * Two-stage stability check: a file must be seen with the same size across
 * two consecutive polls before we notify, so we don't fire on in-progress uploads.
 *
 * Spec: DELIVERY-PIPELINE-SPEC.md, "Dropbox Watcher".
 */

import { createAdminClient } from '../supabase/admin'
import { queueScanIO, runQueueScan } from './queue-scan'

export interface NewFileNotification {
  dropbox_id: string
  path: string
  size_bytes: number
}

/** Persisted delta discovery with a bounded, fairly rotated stability backlog. */
export async function scanDeliveryQueue(): Promise<NewFileNotification[]> {
  return runQueueScan(queueScanIO())
}

/** Lowercase, letters+digits only — folder names vs project names/safe names. */
function squash(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** First path segment under /Delivery-Queue/, or null for root-level files. */
export function deliveryQueueProjectFolder(path: string): string | null {
  const m = path.match(/\/delivery-queue\/([^/]+)\//i)
  return m ? m[1] : null
}

interface ProjectChannelRow {
  id: string
  name: string
  slackChannel: string | null
  safeName: string
}

let projectCache: { rows: ProjectChannelRow[]; at: number } | null = null
const PROJECT_CACHE_MS = 60_000

async function loadProjectChannels(): Promise<ProjectChannelRow[]> {
  if (projectCache && Date.now() - projectCache.at < PROJECT_CACHE_MS) return projectCache.rows
  const sb = createAdminClient()
  const { data } = await sb
    .from('projects')
    .select('id, name, external_links, external_ids, status')
    .eq('status', 'active')
  const rows: ProjectChannelRow[] = (data || []).map((p: any) => ({
    id: p.id,
    name: p.name || '',
    slackChannel: p.external_links?.slack_id || p.external_links?.slack_channel_id || null,
    safeName: p.external_ids?.dropbox_safe_name || '',
  }))
  projectCache = { rows, at: Date.now() }
  return rows
}

/**
 * Resolve which Slack channel a /Delivery-Queue/<project>/ file belongs to.
 * Deliveries are per-project (operator direction) — the folder name is
 * matched against project names and Dropbox safe names, separator- and
 * case-insensitively. Null when the folder doesn't map to one project.
 */
export async function resolveDeliveryChannel(
  path: string,
): Promise<{ channelId: string | null; projectName: string | null }> {
  const folder = deliveryQueueProjectFolder(path)
  if (!folder) return { channelId: null, projectName: null }
  const key = squash(folder)
  if (!key) return { channelId: null, projectName: null }
  const rows = await loadProjectChannels()
  const hits = rows.filter(
    (r) => squash(r.name) === key || (r.safeName && squash(r.safeName) === key),
  )
  if (hits.length !== 1) return { channelId: null, projectName: hits[0]?.name || null }
  return { channelId: hits[0].slackChannel, projectName: hits[0].name }
}

export async function markFileNotified(dropboxId: string): Promise<void> {
  const sb = createAdminClient()
  const { error } = await sb
    .from('seen_dropbox_files')
    .update({ notified_at: new Date().toISOString() })
    .eq('dropbox_id', dropboxId)
  // Throw on failure so a silently-unmarked file can't re-notify every tick.
  if (error) throw new Error(`markFileNotified(${dropboxId}): ${error.message}`)
}
