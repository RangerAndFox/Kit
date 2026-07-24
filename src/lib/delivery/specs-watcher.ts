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
 *
 * SCAN MODEL (why this isn't a full-tree walk anymore):
 *   The scan used to enumerate the ENTIRE /production tree recursively every
 *   minute. As the tree grew, one Dropbox list_folder page exceeded dropboxRpc's
 *   15s AbortSignal budget and the cron failed every minute. It now bounds work
 *   per invocation (invariant 7):
 *     1. DISCOVERY advances a persisted Dropbox cursor (delivery_specs_scan_state,
 *        migration 059) — a bounded `bootstrap` enumeration first (so pre-existing
 *        and outage-period files are recorded, never skipped), then `delta`
 *        (list_folder/continue). Newly-seen files are recorded into the ledger;
 *        the cursor advances one page at a time under a DB lease.
 *     2. FIRE re-lists only the specs folders of projects that still have PENDING
 *        (unnotified) ledger rows, advances the two-sighting stability gate on
 *        those files, and prompts for the stable ones. Bounded by pending
 *        activity, not by total tree size.
 *   Exclusivity + cursor ownership live in `./specs-scan-state`.
 */

import { createAdminClient } from '../supabase/admin'
import { dropboxRpc } from '../dropbox/client'
import { getSeenRowsByIds, insertFirstSightings } from './seen-files'
import { pairSpecsFiles, type SpecsFile, type SpecsKind, type PairResult } from './pairing'
import { recordSpecIntake } from './spec-intake-store'
import {
  getSpecsScanState,
  claimSpecsScanLease,
  advanceSpecsScanCursor,
  releaseSpecsScanLease,
  type SpecsScanPhase,
} from './specs-scan-state'

const WATCH_ROOT = '/production'
const SPECS_RE = /^\/production\/(\d{4})\/([^/]+)\/specs\/(video|audio)\/([^/]+)$/i

export const PICK_SPEC_ACTION = 'kit_delivery_pick_spec'
export const PROVIDE_SPECS_ACTION = 'kit_delivery_provide_specs'

// ── Per-invocation bounds (keep each run well under the hosting limit) ──
/** Max Dropbox discovery pages fetched per invocation. */
const SCAN_MAX_PAGES = 6
/** Max projects whose specs folders are re-listed for firing per invocation. */
const SCAN_MAX_PENDING_PROJECTS = 25
/** Elapsed-time budget per invocation. Conservatively below the route's owned
 *  60s maxDuration (src/app/api/inngest/route.ts): the loop stops STARTING new
 *  work at 30s, leaving ~30s of headroom for one in-flight Dropbox call (15s
 *  ceiling) — so a healthy tick never approaches the platform limit, and any
 *  rare overrun is checkpoint-safe (the cursor resumes next tick). */
const SCAN_TIME_BUDGET_MS = 30_000
/** Defensive pagination cap when re-listing a single specs subfolder. */
const FOLDER_PAGE_CAP = 10

const SLACK_API = 'https://slack.com/api'
const DEFAULT_NOTIFY_CHANNEL = process.env.DELIVERY_NOTIFY_CHANNEL_ID || ''

interface DbxEntry {
  id: string
  name: string
  path_lower?: string
  path_display?: string
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

interface SeenRow {
  dropbox_id: string
  path: string
  size_bytes: number | null
  notified_at: string | null
  stable_check_count: number | null
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

/** Parse a persisted `seen_dropbox_files` row back into a specs file, or null. */
function parseSpecsRow(row: SeenRow): ParsedSpecsFile | null {
  const name = (row.path || '').split('/').pop() || ''
  return parseSpecsPath({ path_display: row.path, name, size: row.size_bytes ?? 0, id: row.dropbox_id })
}

// ─── Pure decision helpers (unit-tested) ────────────────────

/**
 * Choose the Dropbox call for this discovery step from the persisted cursor.
 * No cursor → a fresh recursive enumeration (bootstrap start); an existing
 * cursor → continue (delta OR a bootstrap continuation). Because a delta cursor
 * is never nulled, there is no full-tree restart once bootstrap finishes.
 */
export function planDiscoveryCall(cursor: string | null): { endpoint: string; body: Record<string, unknown> } {
  if (!cursor) {
    return {
      endpoint: '/files/list_folder',
      body: { path: WATCH_ROOT, recursive: true, include_deleted: false, include_non_downloadable_files: false },
    }
  }
  return { endpoint: '/files/list_folder/continue', body: { cursor } }
}

/**
 * Phase after processing a page. Bootstrap completes (→ delta) only when the
 * recursive enumeration is exhausted (has_more=false); delta is terminal.
 */
export function nextPhase(phase: SpecsScanPhase, hasMore: boolean): SpecsScanPhase {
  if (phase === 'delta') return 'delta'
  return hasMore ? 'bootstrap' : 'delta'
}

/**
 * Advance the two-sighting stability gate for a pending file given its current
 * (re-listed) size. Same size twice → fire; same size once → increment; a size
 * change → reset. Identical to the previous full-scan gate; the "second
 * sighting" now comes from the fire-pass re-list one tick after discovery.
 */
export function decideStability(
  prev: { size_bytes: number | null; stable_check_count: number | null },
  liveSize: number,
): { action: 'fire' } | { action: 'update'; patch: { size_bytes: number; stable_check_count: number } } {
  if (prev.size_bytes === liveSize) {
    const nextCount = (prev.stable_check_count || 0) + 1
    if (nextCount >= 2) return { action: 'fire' }
    return { action: 'update', patch: { size_bytes: liveSize, stable_check_count: nextCount } }
  }
  return { action: 'update', patch: { size_bytes: liveSize, stable_check_count: 1 } }
}

// ─── Ledger mutation + lookup helpers ───────────────────────

export async function markSpecsNotified(dropboxId: string): Promise<void> {
  const sb = createAdminClient()
  const { error } = await sb
    .from('seen_dropbox_files')
    .update({ notified_at: new Date().toISOString() })
    .eq('dropbox_id', dropboxId)
  // Throw on failure: callers mark AFTER a confirmed Slack post, so a silently-
  // failed mark would let the SAME prompt re-post next tick. Surfacing it lets
  // the caller decide (we log + tolerate a rare duplicate rather than abort).
  if (error) throw new Error(`markSpecsNotified(${dropboxId}): ${error.message}`)
}

/** Update a pending ledger row's stability fields. */
async function updateSeenRow(
  dropboxId: string,
  patch: { size_bytes?: number; stable_check_count?: number },
): Promise<void> {
  const sb = createAdminClient()
  const { error } = await sb.from('seen_dropbox_files').update(patch).eq('dropbox_id', dropboxId)
  if (error) throw new Error(`updateSeenRow(${dropboxId}): ${error.message}`)
}

/**
 * Terminal eviction: delete a pending row whose file has vanished from Dropbox.
 * Called only when the file's specs folder listed SUCCESSFULLY without it (a
 * transient Dropbox error throws in listSpecsFolder and aborts the tick first),
 * so this is a definitive "gone", not a flaky read. If the file ever returns it
 * is re-discovered fresh (a re-added file gets a new Dropbox id). Throws on a DB
 * error so a failed delete doesn't silently leave the dead row occupying a slot.
 */
async function evictSeenRow(dropboxId: string): Promise<void> {
  const sb = createAdminClient()
  const { error } = await sb.from('seen_dropbox_files').delete().eq('dropbox_id', dropboxId)
  if (error) throw new Error(`evictSeenRow(${dropboxId}): ${error.message}`)
}

/**
 * Pending (unnotified) specs rows — the fire pass's work list. Throws on error.
 *
 * Ordered oldest-first (first_seen_at) so the per-tick project cap makes
 * DETERMINISTIC forward progress: the longest-waiting drops are always served
 * first, and a project deferred past the cap only ages toward the front, so it
 * cannot be starved by continuous fresh activity in other projects.
 */
async function loadPendingSpecsRows(): Promise<SeenRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('seen_dropbox_files')
    .select('dropbox_id, path, size_bytes, notified_at, stable_check_count')
    .is('notified_at', null)
    // ilike, not like: parseSpecsPath's regex is case-insensitive, so a file
    // recorded with non-canonical casing (e.g. `/Specs/`) must still be loaded
    // by the fire pass — a case-sensitive LIKE would strand it, unfired.
    .ilike('path', `${WATCH_ROOT}/%/specs/%`)
    .order('first_seen_at', { ascending: true })
  if (error) throw new Error(`loadPendingSpecsRows: ${error.message}`)
  return (data as SeenRow[]) || []
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

async function defaultSlackPost(channel: string, text: string, blocks?: any[]): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token || !channel) return null
  const body: any = { channel, text, mrkdwn: true }
  if (blocks) body.blocks = blocks
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null)
  if (!res) return null
  const json = await res.json().catch(() => ({}))
  return json.ok ? json.ts : null
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

// ─── Dropbox folder re-list (fire pass) ─────────────────────

function isDropboxNotFound(err: any): boolean {
  const msg = String(err?.message || err || '')
  return /not_found/i.test(msg) || /\b409\b/.test(msg)
}

/**
 * List one specs subfolder (non-recursive) into parsed specs files. A missing
 * folder (a project with only a video or only an audio side) is normal → [].
 */
async function listSpecsFolder(
  rpc: (endpoint: string, body: Record<string, unknown>) => Promise<any>,
  path: string,
): Promise<ParsedSpecsFile[]> {
  const out: ParsedSpecsFile[] = []
  const collect = (r: any) => {
    for (const e of (r.entries || []) as DbxEntry[]) {
      if (e['.tag'] !== 'file') continue
      const p = parseSpecsPath(e as any)
      if (p) out.push(p)
    }
  }
  let resp: any
  try {
    resp = await rpc('/files/list_folder', {
      path,
      recursive: false,
      include_deleted: false,
      include_non_downloadable_files: false,
    })
  } catch (err: any) {
    if (isDropboxNotFound(err)) return []
    throw err
  }
  collect(resp)
  let cursor = resp.has_more ? resp.cursor : undefined
  let guard = FOLDER_PAGE_CAP
  while (cursor && guard-- > 0) {
    resp = await rpc('/files/list_folder/continue', { cursor })
    collect(resp)
    cursor = resp.has_more ? resp.cursor : undefined
  }
  return out
}

// ─── Orchestrator ───────────────────────────────────────────

export interface SpecsScanDeps {
  now: () => number
  rpc: (endpoint: string, body: Record<string, unknown>) => Promise<any>
  getSeenByIds: (ids: string[]) => Promise<Record<string, SeenRow>>
  insertFirstSightings: (rows: { dropbox_id: string; path: string; size_bytes: number }[]) => Promise<void>
  loadPendingSpecs: () => Promise<SeenRow[]>
  updateSeen: (dropboxId: string, patch: { size_bytes?: number; stable_check_count?: number }) => Promise<void>
  evictSeen: (dropboxId: string) => Promise<void>
  markNotified: (dropboxId: string) => Promise<void>
  resolveChannel: (safeName: string) => Promise<{ projectId: string; name: string; channelId: string | null } | null>
  post: (channel: string, text: string, blocks: any[]) => Promise<string | null>
  recordIntake: (opts: { channelId: string; threadTs: string; sources: any[] }) => Promise<void>
  getState: typeof getSpecsScanState
  claimLease: typeof claimSpecsScanLease
  advanceCursor: typeof advanceSpecsScanCursor
  releaseLease: typeof releaseSpecsScanLease
  defaultChannel: string
}

function defaultSpecsScanDeps(): SpecsScanDeps {
  return {
    now: () => Date.now(),
    rpc: (endpoint, body) => dropboxRpc(endpoint, body),
    getSeenByIds: getSeenRowsByIds,
    insertFirstSightings,
    loadPendingSpecs: loadPendingSpecsRows,
    updateSeen: updateSeenRow,
    evictSeen: evictSeenRow,
    markNotified: markSpecsNotified,
    resolveChannel: resolveProjectChannel,
    post: defaultSlackPost,
    recordIntake: recordSpecIntake,
    getState: getSpecsScanState,
    claimLease: claimSpecsScanLease,
    advanceCursor: advanceSpecsScanCursor,
    releaseLease: releaseSpecsScanLease,
    defaultChannel: DEFAULT_NOTIFY_CHANNEL,
  }
}

export interface SpecsScanSummary {
  skipped?: string
  phase?: SpecsScanPhase
  pagesFetched: number
  discovered: number
  projectsChecked: number
  posted: number
  deferredProjects: number
  evicted: number
  bootstrapComplete?: boolean
}

function newHolder(now: number): string {
  const rand = globalThis.crypto?.randomUUID?.() || `${now}-${Math.floor((now * 9301 + 49297) % 233280)}`
  return `specs-scan-${rand}`
}

/**
 * One bounded scan tick: claim the lease, DISCOVER new files into the ledger
 * (bootstrap enumeration → delta), then FIRE prompts for stable pending files.
 *
 * Idempotency / replay:
 *   - Discovery records first sightings via an idempotent upsert and advances
 *     the cursor one page at a time, holder+fence conditional. A failure before
 *     a page's cursor commit replays that page next tick (re-recording is a
 *     no-op). A lost lease (fence bumped by a newer holder) stops the tick.
 *   - Firing is driven by PENDING ledger rows, not the cursor, and marks a file
 *     notified only AFTER a confirmed Slack post. A Slack failure leaves the row
 *     pending → retried next tick. This is the fix for the old mark-BEFORE-post
 *     flow, where a post failure permanently suppressed the delivery.
 *   - Contract is at-least-once: a crash between a successful post and the mark
 *     re-posts next tick (a recoverable duplicate prompt), never a lost delivery.
 */
export async function runSpecsScanTick(overrides: Partial<SpecsScanDeps> = {}, holderOverride?: string): Promise<SpecsScanSummary> {
  const deps: SpecsScanDeps = { ...defaultSpecsScanDeps(), ...overrides }
  const startedAt = deps.now()
  const holder = holderOverride || newHolder(startedAt)
  const overBudget = () => deps.now() - startedAt > SCAN_TIME_BUDGET_MS

  const summary: SpecsScanSummary = {
    pagesFetched: 0,
    discovered: 0,
    projectsChecked: 0,
    posted: 0,
    deferredProjects: 0,
    evicted: 0,
  }

  const claim = await deps.claimLease(holder)
  if (!claim.ok || claim.fence == null) {
    return { ...summary, skipped: 'locked' }
  }
  const fence = claim.fence

  try {
    const state = await deps.getState()
    let phase: SpecsScanPhase = state.phase
    let cursor: string | null = state.cursor

    // Snapshot files pending BEFORE this tick's discovery. A file discovered
    // this tick is NOT fired this tick — its second stability sighting must come
    // from a later tick's re-list, preserving the two-sighting timing.
    const pendingBefore = (await deps.loadPendingSpecs()).map(parseSpecsRow).filter(Boolean) as ParsedSpecsFile[]

    // ── DISCOVERY ──────────────────────────────────────────
    let keepGoing = true
    while (keepGoing && summary.pagesFetched < SCAN_MAX_PAGES && !overBudget()) {
      const call = planDiscoveryCall(cursor)
      const resp = await deps.rpc(call.endpoint, call.body)
      summary.pagesFetched++

      const specs = ((resp.entries || []) as DbxEntry[])
        .filter((e) => e['.tag'] === 'file')
        .map((e) => parseSpecsPath(e as any))
        .filter(Boolean) as ParsedSpecsFile[]
      if (specs.length) {
        const seen = await deps.getSeenByIds(specs.map((s) => s.dropbox_id))
        const fresh = specs.filter((s) => !seen[s.dropbox_id])
        if (fresh.length) {
          await deps.insertFirstSightings(
            fresh.map((s) => ({ dropbox_id: s.dropbox_id, path: s.path, size_bytes: s.size_bytes })),
          )
          summary.discovered += fresh.length
        }
      }

      const hasMore = !!resp.has_more
      const newCursor: string | null = resp.cursor ?? cursor
      const newPhase = nextPhase(phase, hasMore)
      // Checkpoint: advance ONLY after the page is safely recorded, and only if
      // we still own the lease at our fence.
      const owned = await deps.advanceCursor(holder, fence, { cursor: newCursor, phase: newPhase })
      if (!owned) {
        return { ...summary, phase, skipped: 'lease_lost' }
      }
      if (phase === 'bootstrap' && newPhase === 'delta') summary.bootstrapComplete = true
      phase = newPhase
      cursor = newCursor
      keepGoing = hasMore
    }
    summary.phase = phase

    // ── FIRE (stable pending files only) ───────────────────
    const byProject = new Map<string, ParsedSpecsFile[]>()
    for (const p of pendingBefore) {
      const key = `${p.year}/${p.safeName}`
      const arr = byProject.get(key) || []
      arr.push(p)
      byProject.set(key, arr)
    }

    const projectKeys = [...byProject.keys()]
    const coveredThisTick = new Set<string>()
    for (let i = 0; i < projectKeys.length; i++) {
      if (summary.projectsChecked >= SCAN_MAX_PENDING_PROJECTS || overBudget()) {
        summary.deferredProjects = projectKeys.length - i
        // No silent cap: the deferred projects stay pending and run next tick.
        console.warn(
          `[delivery-specs] deferred ${summary.deferredProjects} pending project(s) to next tick (per-invocation cap/budget)`,
        )
        break
      }
      const key = projectKeys[i]
      summary.projectsChecked++
      const slash = key.indexOf('/')
      const year = key.slice(0, slash)
      const safeName = key.slice(slash + 1)

      const videoFiles = await listSpecsFolder(deps.rpc, `${WATCH_ROOT}/${year}/${safeName}/specs/video`)
      const audioFiles = await listSpecsFolder(deps.rpc, `${WATCH_ROOT}/${year}/${safeName}/specs/audio`)
      const liveById = new Map<string, ParsedSpecsFile>()
      for (const f of [...videoFiles, ...audioFiles]) liveById.set(f.dropbox_id, f)

      // Advance stability for this project's pending triggers.
      const triggers = byProject.get(key)!
      const seen = await deps.getSeenByIds(triggers.map((t) => t.dropbox_id))
      const readyToFire: ParsedSpecsFile[] = []
      for (const t of triggers) {
        const prev = seen[t.dropbox_id]
        if (!prev || prev.notified_at) continue
        const live = liveById.get(t.dropbox_id)
        if (!live) {
          // The file is gone from a successfully-listed specs folder (a
          // transient Dropbox error would have thrown above). Evict the dead
          // row so it stops occupying a fire-pass slot — otherwise ≥25 such
          // vanished rows at the front of the oldest-first queue would starve
          // live projects behind them. Terminal: a re-added file returns under
          // a new Dropbox id and is re-discovered fresh.
          await deps.evictSeen(t.dropbox_id)
          summary.evicted++
          console.warn(`[delivery-specs] evicted vanished pending file ${t.path}`)
          continue
        }
        const decision = decideStability(prev, live.size_bytes)
        if (decision.action === 'fire') readyToFire.push(live)
        else await deps.updateSeen(t.dropbox_id, decision.patch)
      }

      // Fire — mirror the existing dedup + pair + post-then-mark + intake flow.
      for (const trigger of readyToFire) {
        if (coveredThisTick.has(trigger.dropbox_id)) {
          await deps.markNotified(trigger.dropbox_id).catch((err) =>
            console.warn(`[delivery-specs] mark (covered) failed: ${err?.message}`),
          )
          continue
        }
        const project = await deps.resolveChannel(safeName)
        const channel = project?.channelId || deps.defaultChannel
        if (!channel) {
          // Nowhere to post — leave pending (do NOT mark) so it retries once a
          // channel is configured.
          console.warn(
            `[delivery-specs] no Slack channel for ${safeName} — will retry (set DELIVERY_NOTIFY_CHANNEL_ID or link the project channel)`,
          )
          continue
        }
        const pair = pairSpecsFiles({ trigger, videoFiles, audioFiles })
        const blocks = buildSpecsPromptBlocks({ projectName: project?.name || safeName, pair })

        // POST first. Mark notified ONLY on a confirmed post — a failed post
        // leaves the row pending for a clean retry next tick.
        const ts = await deps.post(channel, `New delivery source in ${safeName}`, blocks)
        if (!ts) {
          console.warn(`[delivery-specs] Slack post failed for ${safeName} — leaving pending for retry`)
          continue
        }
        coveredThisTick.add(trigger.dropbox_id)
        summary.posted++
        // Mark after the confirmed post. A mark failure here only risks a
        // recoverable duplicate next tick — never a lost delivery — so log and
        // continue rather than aborting the whole tick.
        await deps.markNotified(trigger.dropbox_id).catch((err) =>
          console.warn(`[delivery-specs] mark after post failed for ${safeName}: ${err?.message}`),
        )

        if (pair.ok && pair.video) {
          const pairIds = [pair.video.dropbox_id, pair.audio?.dropbox_id].filter(Boolean) as string[]
          for (const id of pairIds) {
            coveredThisTick.add(id)
            if (id !== trigger.dropbox_id) {
              await deps.markNotified(id).catch((err) =>
                console.warn(`[delivery-specs] pair-partner mark failed: ${err?.message}`),
              )
            }
          }
          const sources = [
            { path: pair.video.path, type: 'video', size_bytes: pair.video.size_bytes },
            ...(pair.audio ? [{ path: pair.audio.path, type: 'audio', size_bytes: pair.audio.size_bytes }] : []),
          ]
          await deps.recordIntake({ channelId: channel, threadTs: ts, sources }).catch(() => {})
        }
      }
    }

    return summary
  } finally {
    await deps.releaseLease(holder).catch(() => {})
  }
}
