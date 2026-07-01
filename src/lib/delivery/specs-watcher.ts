// @ts-nocheck
/**
 * Per-project delivery "specs" folder watcher.
 *
 * New delivery model: each project has `/production/{year}/{safeName}/specs/`
 * with `video/` and `audio/` subfolders. A picture lands in specs/video and its
 * mix in specs/audio; Kit pairs them, validates, and prompts the project's own
 * Slack channel for a delivery spec (replacing the single global /Delivery-Queue).
 *
 * Reuses the `seen_dropbox_files` stability table (two same-size sightings
 * before firing, so we don't trigger on a half-uploaded file).
 */

import { createAdminClient } from '../supabase/admin'
import { dropboxHeaders } from '../dropbox/client'
import { getSeenRowsByIds, insertFirstSightings } from './seen-files'
import { pairSpecsFiles, type SpecsFile, type SpecsKind, type PairResult } from './pairing'

const DROPBOX_API = 'https://api.dropboxapi.com/2'
const WATCH_ROOT = '/production'
const SPECS_RE = /^\/production\/(\d{4})\/([^/]+)\/specs\/(video|audio)\/([^/]+)$/i

export const PICK_SPEC_ACTION = 'kit_delivery_pick_spec'
export const PROVIDE_SPECS_ACTION = 'kit_delivery_provide_specs'

interface DbxFile {
  id: string
  name: string
  path_lower: string
  path_display: string
  size: number
  '.tag': 'file' | 'folder' | 'deleted'
}

export interface ParsedSpecsFile extends SpecsFile {
  year: string
  safeName: string
}

export interface SpecsDrop {
  trigger: ParsedSpecsFile
  year: string
  safeName: string
  videoFiles: ParsedSpecsFile[]
  audioFiles: ParsedSpecsFile[]
}

async function dropboxPost(endpoint: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${DROPBOX_API}${endpoint}`, {
    method: 'POST',
    headers: await dropboxHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Dropbox ${endpoint} ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return res.json()
}

async function listProductionFiles(): Promise<DbxFile[]> {
  const out: DbxFile[] = []
  let response = await dropboxPost('/files/list_folder', {
    path: WATCH_ROOT,
    recursive: true,
    include_deleted: false,
    include_non_downloadable_files: false,
  })
  const collect = (r: any) => {
    for (const e of r.entries || []) {
      if (e['.tag'] === 'file' && e.path_lower) out.push(e)
    }
  }
  collect(response)
  let cursor = response.has_more ? response.cursor : undefined
  while (cursor) {
    response = await dropboxPost('/files/list_folder/continue', { cursor })
    collect(response)
    cursor = response.has_more ? response.cursor : undefined
  }
  return out
}

/** Parse a Dropbox file into a specs file, or null if it isn't under a specs folder. */
export function parseSpecsPath(f: { path_display?: string; path_lower?: string; name: string; size: number; id: string }): ParsedSpecsFile | null {
  const path = f.path_display || f.path_lower || ''
  const m = path.match(SPECS_RE)
  if (!m) return null
  // Ignore scratch/partial files.
  if (/\.tmp$|\.part$|\.crdownload$|~\$/i.test(f.name)) return null
  return {
    path,
    name: m[4],
    kind: m[3].toLowerCase() as SpecsKind,
    size_bytes: f.size,
    dropbox_id: f.id,
    year: m[1],
    safeName: m[2],
  }
}

/**
 * One scan tick. Returns newly-stable specs drops, each bundled with the
 * current contents of that project's specs/video + specs/audio folders so the
 * caller can pair without another Dropbox round-trip.
 */
export async function scanProjectSpecs(): Promise<SpecsDrop[]> {
  const sb = createAdminClient()
  const live = await listProductionFiles()
  const specs = live.map(parseSpecsPath).filter(Boolean) as ParsedSpecsFile[]
  if (specs.length === 0) return []

  const byProject = new Map<string, { video: ParsedSpecsFile[]; audio: ParsedSpecsFile[] }>()
  for (const s of specs) {
    const key = `${s.year}/${s.safeName}`
    const g = byProject.get(key) || { video: [], audio: [] }
    ;(s.kind === 'video' ? g.video : g.audio).push(s)
    byProject.set(key, g)
  }

  // Seen rows scoped to this scan's ids (the old select('*') walked the
  // whole ever-growing table every minute), first sightings batched.
  const seenById = await getSeenRowsByIds(specs.map((s) => s.dropbox_id))
  await insertFirstSightings(
    specs
      .filter((s) => !seenById[s.dropbox_id])
      .map((s) => ({ dropbox_id: s.dropbox_id, path: s.path, size_bytes: s.size_bytes })),
  )

  const drops: SpecsDrop[] = []
  for (const s of specs) {
    const prev = seenById[s.dropbox_id]
    if (!prev) continue // first sighting recorded above; stability check next tick
    if (prev.notified_at) continue
    if (prev.size_bytes === s.size_bytes) {
      const newCount = (prev.stable_check_count || 0) + 1
      if (newCount >= 2) {
        const g = byProject.get(`${s.year}/${s.safeName}`)!
        drops.push({ trigger: s, year: s.year, safeName: s.safeName, videoFiles: g.video, audioFiles: g.audio })
      } else {
        await sb.from('seen_dropbox_files').update({ stable_check_count: newCount }).eq('dropbox_id', s.dropbox_id)
      }
    } else {
      await sb.from('seen_dropbox_files').update({ size_bytes: s.size_bytes, stable_check_count: 1 }).eq('dropbox_id', s.dropbox_id)
    }
  }
  return drops
}

export async function markSpecsNotified(dropboxId: string): Promise<void> {
  const sb = createAdminClient()
  await sb.from('seen_dropbox_files').update({ notified_at: new Date().toISOString() }).eq('dropbox_id', dropboxId)
}

/** Look up the project (name + Slack channel) for a Dropbox safeName. */
export async function resolveProjectChannel(
  safeName: string,
): Promise<{ projectId: string; name: string; channelId: string | null } | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('projects')
    .select('id, name, external_links')
    .filter('external_ids->>dropbox_safe_name', 'eq', safeName)
    .maybeSingle()
  if (!data) return null
  return { projectId: data.id, name: data.name, channelId: data.external_links?.slack_id || null }
}

/**
 * Build the channel prompt for a stable drop: the chosen pair, any warnings,
 * and a "Pick delivery spec" button carrying the source files. Pure — tested.
 */
export function buildSpecsPromptBlocks(opts: {
  projectName: string
  pair: PairResult
}): any[] {
  const { projectName, pair } = opts
  const lines: string[] = [`:inbox_tray: *New delivery source — ${projectName}*`]
  if (pair.video) lines.push(`:film_frames: video — \`${pair.video.name}\``)
  if (pair.audio) lines.push(`:musical_note: audio — \`${pair.audio.name}\``)
  for (const w of pair.warnings) lines.push(`:warning: ${w}`)

  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
  ]

  // Only offer the render button when there's a picture to work with.
  if (pair.ok && pair.video) {
    const sources = [
      { path: pair.video.path, type: 'video', size_bytes: pair.video.size_bytes },
      ...(pair.audio ? [{ path: pair.audio.path, type: 'audio', size_bytes: pair.audio.size_bytes }] : []),
    ]
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: pair.needsChoice ? 'Review & pick spec' : 'Pick delivery spec' },
          action_id: PICK_SPEC_ACTION,
          value: JSON.stringify({ sources }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Provide specs' },
          action_id: PROVIDE_SPECS_ACTION,
          value: JSON.stringify({ sources }),
        },
      ],
    })
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            'Pick a saved spec, tap *Provide specs* to paste one, ' +
            'or just reply in this thread with the spec — text, a PDF, or a screenshot — and I’ll extract it.',
        },
      ],
    })
  }
  return blocks
}
