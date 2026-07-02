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
import { dropboxHeaders } from '../dropbox/client'
import { getSeenRowsByIds, insertFirstSightings } from './seen-files'

const DROPBOX_API = 'https://api.dropboxapi.com/2'
const WATCH_PATH = '/Delivery-Queue'

interface DropboxFileMetadata {
  id: string
  name: string
  path_lower: string
  path_display: string
  size: number
  '.tag': 'file' | 'folder' | 'deleted'
  is_downloadable?: boolean
}

async function dropboxPost(endpoint: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${DROPBOX_API}${endpoint}`, {
    method: 'POST',
    headers: await dropboxHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Dropbox ${endpoint} ${res.status}: ${text}`)
  }
  return res.json()
}

/**
 * Recursively list all files under WATCH_PATH. Returns only `.tag === 'file'`
 * entries, with `/delivery/` and `/output/` subfolders filtered out.
 */
async function listDeliveryQueueFiles(): Promise<DropboxFileMetadata[]> {
  const out: DropboxFileMetadata[] = []
  let cursor: string | undefined
  let response: any

  // Initial call
  response = await dropboxPost('/files/list_folder', {
    path: WATCH_PATH,
    recursive: true,
    include_deleted: false,
    include_non_downloadable_files: false,
  })
  collectEntries(response, out)
  cursor = response.has_more ? response.cursor : undefined

  // Pagination
  while (cursor) {
    response = await dropboxPost('/files/list_folder/continue', { cursor })
    collectEntries(response, out)
    cursor = response.has_more ? response.cursor : undefined
  }

  return out
}

function collectEntries(response: any, out: DropboxFileMetadata[]): void {
  for (const entry of response.entries || []) {
    if (entry['.tag'] !== 'file') continue
    if (!entry.path_lower) continue
    // Filter outputs (anything under /delivery/ or /output/ subfolders)
    if (/\/(delivery|output)\//i.test(entry.path_lower)) continue
    // Filter scratch / temp files
    if (/\.tmp$|\.part$|\.crdownload$|~\$/i.test(entry.name)) continue
    out.push(entry)
  }
}

export interface NewFileNotification {
  dropbox_id: string
  path: string
  size_bytes: number
}

/**
 * One scan tick. Returns the list of newly-stable files that should be
 * notified about. Caller is responsible for posting Slack messages and
 * updating notified_at after a successful post.
 */
export async function scanDeliveryQueue(): Promise<NewFileNotification[]> {
  const sb = createAdminClient()
  const liveFiles = await listDeliveryQueueFiles()
  if (liveFiles.length === 0) return []

  // Seen rows scoped to this scan's ids (the old select('*') walked the
  // whole ever-growing table every minute), first sightings batched.
  const seenById = await getSeenRowsByIds(liveFiles.map((f: any) => f.id))
  await insertFirstSightings(
    liveFiles
      .filter((f: any) => !seenById[f.id])
      .map((f: any) => ({ dropbox_id: f.id, path: f.path_display, size_bytes: f.size })),
  )

  const ready: NewFileNotification[] = []

  for (const f of liveFiles) {
    const prev = seenById[f.id]
    if (!prev) continue // first sighting recorded above; stability check next tick

    if (prev.notified_at) continue // already notified

    if (prev.size_bytes === f.size) {
      const newCount = (prev.stable_check_count || 0) + 1
      if (newCount >= 2) {
        // Stable — caller should notify, then mark
        ready.push({ dropbox_id: f.id, path: f.path_display, size_bytes: f.size })
      } else {
        await sb
          .from('seen_dropbox_files')
          .update({ stable_check_count: newCount })
          .eq('dropbox_id', f.id)
      }
    } else {
      // Size changed — reset stability counter
      await sb
        .from('seen_dropbox_files')
        .update({ size_bytes: f.size, stable_check_count: 1 })
        .eq('dropbox_id', f.id)
    }
  }

  return ready
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
