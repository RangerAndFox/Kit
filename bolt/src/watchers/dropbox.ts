/**
 * Dropbox → Frame.io watcher.
 *
 * On a Dropbox webhook hit, we pull the cursor delta over /production
 * (recursive), filter for files dropped into any project's
 * `09_Outgoing/{01_Client Progress | 02_Delivery}` folder, then:
 *   1. Look up the project by `external_ids->>dropbox_safe_name`
 *   2. Find the Frame.io `03_Outgoing/{same subfolder}` destination
 *   3. Get a Dropbox temporary download link
 *   4. Hand it to Frame.io remote_upload (no buffering through this server)
 *   5. Create a Frame.io review link
 *   6. DM the project's PM (project_manager_slack_id)
 *
 * Webhook signature is verified via HMAC-SHA256 of the raw POST body
 * using DROPBOX_APP_SECRET, per Dropbox's spec.
 */
import crypto from 'node:crypto'
import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { dropboxHeaders } from '../../../src/lib/dropbox/client'
import { frameioHeaders } from '../../../src/lib/frameio/auth'
import { frameioProjectUrl, normalizeFrameioNextLink } from '../../../src/lib/frameio/url'
import { listFrameioProjectShares, newestFrameioProjectShare } from '../../../src/lib/frameio/shares'
import { isFrameioUploadEnabled } from '../../../src/lib/projects/settings'
import { processSrtFile } from '../../../src/lib/delivery/subtitle-watcher'
import {
  registerProjectShare,
  syncProjectShareEvent,
  type RegisteredProjectShare,
} from '../../../src/lib/project-control/share-progress'
import { readLatestShare, recordLatestShare } from '../../../src/lib/project-control/sheets'
import { requestProjectControlSync } from '../../../src/lib/project-control/sync-request'
import { workbookConfigFromEnv } from '../../../src/lib/project-control/types'
import type { Json } from '../../../src/types/supabase'

type JsonRecord = { [key: string]: Json | undefined }

function asJsonRecord(value: Json | null | undefined): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const DROPBOX_API = 'https://api.dropboxapi.com/2'
const FRAMEIO_API = 'https://api.frame.io/v4'

const WATCH_ROOT = '/production'

// Match `/production/<year>/<safeName>/09_Outgoing/(01_Client Progress|02_Delivery)/<filename>`
// path_display preserves the original casing.
const PATH_RE = /^\/production\/(\d{4})\/([^/]+)\/09_Outgoing\/(01_Client Progress|02_Delivery)\/(.+)$/i

// An .srt landing in any accessibility folder inside a project tree
// ("02_Accessibility Files" and similar) → generate TTML/VTT/TXT siblings.
// The .srt's immediate parent folder must contain "accessibility".
const ACCESSIBILITY_SRT_RE =
  /^\/production\/\d{4}\/([^/]+)\/(?:.*\/)?[^/]*accessibility[^/]*\/[^/]+\.srt$/i

// An .aep landing in a project's AE render-farm watch folder → auto-submit to
// the Deadline render farm (renders the project's own render queue).
// Match `/production/<year>/<safeName>/08_AE/03_RenderFarm/<file>.aep`
const AE_RENDERFARM_RE =
  /^\/production\/(\d{4})\/([^/]+)\/08_AE\/03_RenderFarm\/([^/]+\.aep)$/i

// The same production tree as the farm nodes see it. The Dropbox path
// /production/<rest> maps to `${AE_FARM_UNC_ROOT}\<rest>`.
const AE_FARM_UNC_ROOT = process.env.AE_FARM_UNC_ROOT || '\\\\thewire\\production'

/** If the path is a render-farm .aep drop, return its parts; else null. */
export function matchAeRenderFarmDrop(
  path: string,
): { year: string; safeName: string; filename: string } | null {
  const m = path.match(AE_RENDERFARM_RE)
  if (!m) return null
  // The relay saves prepared farm copies (<name>__kitfarm.aep) back into the
  // watch folder — those are outputs of a submission, never triggers.
  if (/__kitfarm\.aep$/i.test(m[3])) return null
  return { year: m[1], safeName: m[2], filename: m[3] }
}

/**
 * If the path is a project-tree accessibility SRT, return its safeName;
 * else null. Pure — exported for tests.
 */
export function matchAccessibilitySrt(path: string): string | null {
  const m = path.match(ACCESSIBILITY_SRT_RE)
  return m ? m[1] : null
}

// File extensions to skip when mirroring deliveries to Frame.io — e.g. audio
// sidecars / proxies dropped next to the actual video deliverable. Override
// with a comma-separated DELIVERY_DENY_EXTENSIONS; defaults to aac + m4v.
const DENY_EXTENSIONS = new Set(
  (process.env.DELIVERY_DENY_EXTENSIONS || 'aac,m4v')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean),
)

/**
 * True if a delivery file should be skipped based on its extension. `filename`
 * may include intermediate subfolders (e.g. "051326/v1/mix.aac"); only the
 * final segment's extension is considered.
 */
export function isDeniedDeliveryFile(
  filename: string,
  deny: Set<string> = DENY_EXTENSIONS,
): boolean {
  const base = filename.split('/').pop() || filename
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  return deny.has(base.slice(dot + 1).toLowerCase())
}


// ─── Signature verification ─────────────────────────────────

export function verifyDropboxSignature(
  rawBody: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false
  const secret = process.env.DROPBOX_APP_SECRET
  if (!secret) {
    console.error('[dropbox-watcher] DROPBOX_APP_SECRET not set; cannot verify webhook')
    return false
  }
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(signature, 'hex'))
  } catch {
    return false
  }
}

// ─── Dropbox helpers ────────────────────────────────────────

async function dbxPost(endpoint: string, body: any): Promise<any> {
  const r = await fetch(`${DROPBOX_API}${endpoint}`, {
    method: 'POST',
    headers: await dropboxHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!r.ok) throw new Error(`Dropbox ${endpoint} ${r.status}: ${await r.text()}`)
  return r.json()
}

// ─── Cursor state ───────────────────────────────────────────

async function loadCursor(): Promise<string | null> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('dropbox_state')
    .select('cursor')
    .eq('id', 'singleton')
    .maybeSingle()
  if (error) throw new Error(`loadCursor failed: ${error.message}`)
  return data?.cursor || null
}

async function saveCursor(cursor: string): Promise<void> {
  const sb = createAdminClient()
  // Upsert, not update: update() matching zero rows is a silent success, so
  // if the singleton row was never seeded the cursor would never persist and
  // the watcher would "seed and exit" on every webhook forever.
  const { error } = await sb
    .from('dropbox_state')
    .upsert(
      { id: 'singleton', cursor, updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    )
  if (error) throw new Error(`saveCursor failed: ${error.message}`)
}

async function seedCursor(): Promise<string> {
  // /files/list_folder/get_latest_cursor returns a cursor anchored to "now"
  // without enumerating existing files — exactly what we want on first run.
  const r = await dbxPost('/files/list_folder/get_latest_cursor', {
    path: WATCH_ROOT,
    recursive: true,
    include_deleted: false,
  })
  await saveCursor(r.cursor)
  return r.cursor
}

// ─── Delta polling ──────────────────────────────────────────

interface DropEntry {
  path_lower: string
  path_display: string
  name: string
  tag: string
  size?: number
  id?: string   // Dropbox file id — stable across renames/edits
  rev?: string  // revision — changes on every content update
}

export type DropboxInboxEvent = {
  event_key: string
  event_type: 'accessibility_srt' | 'ae_render' | 'frameio_delivery'
  payload: Record<string, unknown>
}

function stableDropboxEventKey(kind: string, entry: DropEntry): string {
  const identity = `${kind}:${entry.id || entry.path_lower}:${entry.rev || 'unversioned'}`
  return `dbx:${crypto.createHash('sha256').update(identity).digest('hex')}`
}

/** Convert one Dropbox delta into durable work, or null when Kit does not own
 * the path. Kept pure so routing and dedupe identities can be contract-tested. */
export function classifyDropboxEntry(entry: DropEntry): DropboxInboxEvent | null {
  if (entry.tag !== 'file') return null

  const safeName = matchAccessibilitySrt(entry.path_display)
  if (safeName) return {
    event_key: stableDropboxEventKey('accessibility_srt', entry),
    event_type: 'accessibility_srt',
    payload: { path: entry.path_display, safeName, sizeBytes: entry.size || 0 },
  }

  const ae = matchAeRenderFarmDrop(entry.path_display)
  if (ae) return {
    event_key: stableDropboxEventKey('ae_render', entry),
    event_type: 'ae_render',
    payload: {
      ...ae,
      dropboxId: entry.id || entry.path_lower,
      rev: entry.rev || '',
    },
  }

  const match = entry.path_display.match(PATH_RE)
  if (!match) return null
  const [, year, projectSafeName, subfolder, filename] = match
  if (isDeniedDeliveryFile(filename)) return null
  return {
    event_key: stableDropboxEventKey('frameio_delivery', entry),
    event_type: 'frameio_delivery',
    payload: {
      path: entry.path_display,
      name: filename,
      safeName: projectSafeName,
      subfolder,
      year,
      dropboxId: entry.id || entry.path_lower,
      rev: entry.rev || '',
    },
  }
}

async function fetchDeltas(initial: string): Promise<{ entries: DropEntry[]; newCursor: string }> {
  const entries: DropEntry[] = []
  let cursor = initial
  let safety = 50 // pagination cap so a runaway cursor can't loop forever
  while (safety-- > 0) {
    const r: any = await dbxPost('/files/list_folder/continue', { cursor })
    for (const e of r.entries || []) {
      entries.push({
        path_lower: e.path_lower,
        path_display: e.path_display,
        name: e.name,
        tag: e['.tag'],
        size: e.size,
        id: e.id,
        rev: e.rev,
      })
    }
    cursor = r.cursor
    if (!r.has_more) break
  }
  return { entries, newCursor: cursor }
}

// ─── Main entrypoint ────────────────────────────────────────

// Serialize runs: Dropbox sends webhook bursts, and two concurrent runs
// would read the same cursor and process identical entries twice (duplicate
// Frame.io uploads + duplicate PM DMs). A notification that arrives mid-run
// just flags a re-run so its deltas are picked up when the current pass ends.
let _running = false
let _rerunRequested = false

export async function processDropboxNotification(app: App): Promise<void> {
  if (_running) {
    _rerunRequested = true
    return
  }
  _running = true
  try {
    do {
      _rerunRequested = false
      await processDeltasOnce(app)
    } while (_rerunRequested)
  } finally {
    _running = false
  }
}

async function processDeltasOnce(app: App): Promise<void> {
  let cursor = await loadCursor()
  if (!cursor) {
    await seedCursor()
    console.log('[dropbox-watcher] seeded cursor on first run; no deltas to process')
    await drainDropboxInbox(app)
    return
  }

  const { entries, newCursor } = await fetchDeltas(cursor)
  const events = entries.map(classifyDropboxEntry).filter(Boolean) as DropboxInboxEvent[]
  const sb = createAdminClient()
  const { data: inserted, error } = await sb.rpc('ingest_dropbox_event_batch', {
    p_previous_cursor: cursor,
    p_new_cursor: newCursor,
    p_events: events as unknown as Json,
  })
  if (error) throw new Error(`Dropbox inbox ingest failed: ${error.message}`)

  console.log(
    `[dropbox-watcher] ingested ${inserted || 0}/${events.length} actionable events from ${entries.length} deltas`,
  )
  await drainDropboxInbox(app)
}

type ClaimedDropboxEvent = DropboxInboxEvent & {
  id: string
  claim_token: string
  attempt_count: number
}

const FRAMEIO_PROCESSING_POLL_SECONDS = 300
const FRAMEIO_PROCESSING_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** A provider has accepted the work but has not completed it yet. This is a
 * scheduling outcome, not an error, and must not consume the inbox retry
 * budget. */
export class DropboxEventDeferred extends Error {
  constructor(message: string, readonly delaySeconds = FRAMEIO_PROCESSING_POLL_SECONDS) {
    super(message)
    this.name = 'DropboxEventDeferred'
  }
}

async function dispatchDropboxEvent(app: App, event: ClaimedDropboxEvent): Promise<void> {
  const payload = event.payload as any
  if (event.event_type === 'accessibility_srt') {
    await handleAccessibilitySrt(app, payload)
    return
  }
  if (event.event_type === 'ae_render') {
    await handleAeRenderFarmDrop(app, payload)
    return
  }
  await handleNewDelivery(app, payload)
  if (/02_Delivery/i.test(payload.subfolder || '')) {
    const safeName = String(payload.safeName || '')
    const projectName = safeName.replace(/^\d+[A-Za-z]?[_-]/, '').replace(/[_-]+/g, ' ').trim() || safeName
    import('../celebrations/celebrations')
      .then(({ postDeliveryCelebration }) => postDeliveryCelebration(app, projectName))
      .catch((e) => console.warn(`[dropbox-watcher] delivery celebration failed: ${e?.message || e}`))
  }
}

/** Drain due events. Claims are fenced in Postgres, so overlapping Railway
 * instances and expired leases cannot complete or fail one another's work. */
export async function drainDropboxInbox(
  app: App,
  options: { workerId?: string; batchSize?: number; maxBatches?: number } = {},
): Promise<{ claimed: number; completed: number; deferred: number; failed: number; deadLettered: number }> {
  const sb = createAdminClient()
  const workerId = options.workerId || `bolt:${process.pid}:${crypto.randomUUID()}`
  const batchSize = Math.min(Math.max(options.batchSize || 10, 1), 100)
  const maxBatches = Math.min(Math.max(options.maxBatches || 10, 1), 100)
  const result = { claimed: 0, completed: 0, deferred: 0, failed: 0, deadLettered: 0 }

  for (let batch = 0; batch < maxBatches; batch++) {
    const { data, error } = await sb.rpc('claim_dropbox_events', {
      p_worker_id: workerId,
      p_limit: batchSize,
      p_lease_seconds: 300,
    })
    if (error) throw new Error(`Dropbox inbox claim failed: ${error.message}`)
    const claimed = (data || []) as ClaimedDropboxEvent[]
    if (claimed.length === 0) break
    result.claimed += claimed.length

    for (const event of claimed) {
      try {
        await dispatchDropboxEvent(app, event)
        const { data: completed, error: completeError } = await sb.rpc('complete_dropbox_event', {
          p_event_id: event.id,
          p_claim_token: event.claim_token,
        })
        if (completeError) throw new Error(`completion checkpoint failed: ${completeError.message}`)
        if (!completed) throw new Error('completion lease was lost')
        result.completed++
      } catch (error: any) {
        if (error instanceof DropboxEventDeferred) {
          const { data: deferred, error: deferError } = await sb.rpc('defer_dropbox_event', {
            p_event_id: event.id,
            p_claim_token: event.claim_token,
            p_reason: error.message,
            p_delay_seconds: error.delaySeconds,
          })
          if (deferError) throw new Error(`deferral checkpoint failed: ${deferError.message}`)
          if (!deferred) throw new Error('deferral lease was lost')
          result.deferred++
          console.log(`[dropbox-inbox] ${event.event_type} ${event.id} deferred: ${error.message}`)
          continue
        }
        result.failed++
        const message = error?.message || String(error)
        const { data: status, error: failError } = await sb.rpc('fail_dropbox_event', {
          p_event_id: event.id,
          p_claim_token: event.claim_token,
          p_error: message,
        })
        if (failError) console.error(`[dropbox-inbox] could not checkpoint ${event.id}: ${failError.message}`)
        if (status === 'dead_letter') result.deadLettered++
        console.error(`[dropbox-inbox] ${event.event_type} ${event.id} ${status || 'lease-lost'}: ${message}`)
      }
    }
  }
  return result
}

// ─── Per-file pipeline ──────────────────────────────────────

interface Delivery {
  path: string
  name: string
  safeName: string
  subfolder: string // "01_Client Progress" | "02_Delivery"
  year: string
  dropboxId: string
  rev: string
}

type DeliveryProject = {
  id: string
  name: string
  client: string
  project_manager_slack_id?: string | null
  external_links?: JsonRecord | null
  external_ids?: JsonRecord | null
}

async function notifyProjectShare(
  app: App,
  input: {
    project: DeliveryProject
    fileName: string
    reviewUrl: string
    subfolderLine: string
    progression: RegisteredProjectShare | null
    recovered?: boolean
  },
): Promise<void> {
  const { project, fileName, reviewUrl, subfolderLine, progression } = input
  const linkLine = reviewUrl ? `<${reviewUrl}|Open review on Frame.io>` : '_(no review link)_'
  const text = input.recovered
    ? `♻️ *Recovered Frame.io share for ${project.name}* (${project.client})\n` +
      `• File: \`${fileName}\`\n` +
      `• ${linkLine}`
    : `📦 *New delivery for ${project.name}* (${project.client})\n` +
      `• Subfolder: \`${subfolderLine}\`\n` +
      `• File: \`${fileName}\`\n` +
      `• ${linkLine}`

  const pmId = project.project_manager_slack_id || undefined
  const channelId = project.external_links?.slack_id as string | undefined
  const fallbackPm = process.env.KIT_FALLBACK_PM_SLACK_ID
  const target = pmId || channelId || fallbackPm
  if (!target) {
    console.warn(`[dropbox-watcher] project ${project.id} has no notification target`)
    return
  }

  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text } }]
  if (progression?.eventId) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: progression.milestone
      ? `Kit matched this to *${progression.milestone}* (${progression.confidence}). Advance the live workback?`
      : 'Kit could not confidently match this filename to a workback milestone. The latest-share link was updated; review the schedule manually.' } })
    if (progression.milestone) blocks.push({ type: 'actions', elements: [
      { type: 'button', action_id: 'kit_project_share_advance', style: 'primary', text: { type: 'plain_text', text: 'Yes, advance workback' }, value: progression.eventId },
      { type: 'button', action_id: 'kit_project_share_dismiss', text: { type: 'plain_text', text: 'No, keep current milestone' }, value: progression.eventId },
    ] })
  }

  const posted = await app.client.chat.postMessage({
    channel: target,
    text: input.recovered ? `♻️ Recovered Frame.io share for *${project.name}*` : `📦 New delivery for *${project.name}*`,
    blocks,
  })
  if (progression?.eventId && posted.ts) {
    const { error } = await createAdminClient().from('project_share_events')
      .update({ slack_channel_id: target, slack_message_ts: posted.ts, updated_at: new Date().toISOString() })
      .eq('id', progression.eventId)
      .is('slack_message_ts', null)
    if (error) throw new Error(`share notification ledger update failed: ${error.message}`)
  }
  console.log(`[dropbox-watcher] notified ${pmId ? `PM ${pmId}` : channelId ? `channel ${channelId}` : `fallback ${fallbackPm}`}`)
}

/**
 * An .srt landed in a project's accessibility folder: generate the TTML,
 * VTT, and TXT siblings next to it (same basename) and post a note to the
 * project channel. Conversion is the deliverable — it runs even when the
 * project or its channel can't be resolved.
 */
async function handleAccessibilitySrt(
  app: App,
  d: { path: string; safeName: string; sizeBytes: number },
): Promise<void> {
  const name = d.path.split('/').pop() || d.path
  let result: { generated: string[]; cueCount: number; srtText: string }
  try {
    result = await processSrtFile({ path: d.path, sizeBytes: d.sizeBytes })
  } catch (err: any) {
    const channel = await resolveProjectChannelBySafeName(d.safeName)
    if (channel) {
      await app.client.chat
        .postMessage({
          channel,
          text: `Caption conversion failed: ${name}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `:warning: Couldn't convert \`${d.path}\` — ${err.message}` },
            },
          ],
        })
        .catch(() => {})
    }
    throw err
  }

  console.log(`[dropbox-watcher] captions generated from ${d.path} (${result.cueCount} cues)`)

  const channel = await resolveProjectChannelBySafeName(d.safeName)
  if (!channel) return
  const siblings = result.generated.map((p) => `\`${p.split('/').pop()}\``).join(', ')
  await app.client.chat
    .postMessage({
      channel,
      text: `Captions generated from ${name}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `:speech_balloon: *Captions generated* from \`${name}\` (${result.cueCount} cues)\n` +
              `${siblings} dropped in the same folder.`,
          },
        },
      ],
    })
    .catch((e) => console.warn(`[dropbox-watcher] caption note post failed: ${e?.message}`))

  // ── Proofread QC ──────────────────────────────────────────
  // Proofread the SRT and post a pass/fail report in the same channel.
  // Non-fatal: a QC failure must never block the caption deliverable.
  try {
    const { proofreadSrt, buildQcBlocks } = await import('../delivery/srt-qc')
    const report = await proofreadSrt(result.srtText)
    const blocks = buildQcBlocks(report, name)
    if (blocks) {
      await app.client.chat
        .postMessage({
          channel,
          text: report.clean ? `Caption QC passed: ${name}` : `Caption QC found issues: ${name}`,
          blocks,
        })
        .catch((e) => console.warn(`[dropbox-watcher] QC post failed: ${e?.message}`))
    }
  } catch (err: any) {
    console.warn(`[dropbox-watcher] SRT QC failed for ${d.path}: ${err?.message || err}`)
  }
}

/** Project's Slack channel id from its Dropbox safe name, or null. */
/**
 * An .aep landed in a project's 08_AE/03_RenderFarm watch folder: submit it to
 * the Deadline render farm (the relay reads the project's own render queue and
 * renders every queued item). Dedupe on Dropbox id@rev so each saved revision
 * renders exactly once — re-saving the file re-renders it; webhook replays of
 * the same revision don't.
 */
async function handleAeRenderFarmDrop(
  app: App,
  d: { year: string; safeName: string; filename: string; dropboxId: string; rev: string },
): Promise<void> {
  // Dropbox conflict artifacts ("foo (conflicted copy).aep") are never renders.
  if (/conflicted copy/i.test(d.filename)) {
    console.log(`[dropbox-watcher] skipping conflicted copy: ${d.filename}`)
    return
  }

  // Dedupe: one render per (file id, revision), via the seen_dropbox_files
  // ledger (text pk — key on id@rev so a new revision is a fresh sighting).
  const sb = createAdminClient()
  const seenKey = `aefarm:${d.dropboxId}@${d.rev}`
  const { data: inserted } = await sb
    .from('seen_dropbox_files')
    .upsert(
      {
        dropbox_id: seenKey,
        path: `/production/${d.year}/${d.safeName}/08_AE/03_RenderFarm/${d.filename}`,
        size_bytes: 0,
        stable_check_count: 1,
        notified_at: new Date().toISOString(),
      },
      { onConflict: 'dropbox_id', ignoreDuplicates: true },
    )
    .select('dropbox_id')
  if (!inserted || inserted.length === 0) {
    console.log(`[dropbox-watcher] AE drop already rendered: ${seenKey}`)
    return
  }

  // Translate to the SAN path the relay + Deadline nodes read.
  const uncPath = `${AE_FARM_UNC_ROOT}\\${d.year}\\${d.safeName}\\08_AE\\03_RenderFarm\\${d.filename}`

  const channel = await resolveProjectChannelBySafeName(d.safeName)

  const { submitAeRenderFromProject } = await import('../../../src/lib/delivery/ae-storage')
  try {
    await submitAeRenderFromProject({
      projectPath: uncPath,
      requestedBy: 'dropbox-watcher',
      slackChannel: channel || undefined,
    })
  } catch (err) {
    // Release the id@rev claim so the cursor-retry can submit this revision.
    await sb.from('seen_dropbox_files').delete().eq('dropbox_id', seenKey)
    throw err
  }

  console.log(`[dropbox-watcher] AE render submitted: ${uncPath}`)
  if (channel) {
    await app.client.chat.postMessage({
      channel,
      text:
        `:clapper: *Render farm* — \`${d.filename}\` dropped in 03_RenderFarm.\n` +
        `Reading its After Effects render queue and sending the queued comps to Deadline. ` +
        `Track with \`/kit render status\`.`,
    })
  }
}

async function resolveProjectChannelBySafeName(safeName: string): Promise<string | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('projects')
    .select('external_links')
    .filter('external_ids->>dropbox_safe_name', 'eq', safeName)
    .maybeSingle()
  const links = asJsonRecord(data?.external_links)
  return typeof links.slack_id === 'string'
    ? links.slack_id
    : typeof links.slack_channel_id === 'string' ? links.slack_channel_id : null
}

/**
 * Build the Frame.io v4 Create Share request.
 *
 * This stays pure and exported so provider endpoint/payload drift is covered
 * by a focused contract test. Adobe's v4 collection specifies a project-level
 * shares route with data.type=asset and data.asset_ids.
 */
export function buildFrameioShareRequest(
  accountId: string,
  projectId: string,
  fileId: string,
  name: string,
): { path: string; body: Record<string, unknown> } {
  return {
    path: `/accounts/${accountId}/projects/${projectId}/shares`,
    body: {
      data: {
        type: 'asset',
        name,
        access: 'public',
        asset_ids: [fileId],
      },
    },
  }
}

async function handleNewDelivery(app: App, d: Delivery): Promise<void> {
  // ── Lookup project (or discover from Frame.io) ──────────
  const sb = createAdminClient()
  const { data: existing, error } = await sb
    .from('projects')
    .select(
      'id, name, client, project_code, project_manager_slack_id, external_links, external_ids',
    )
    .filter('external_ids->>dropbox_safe_name', 'eq', d.safeName)
    .maybeSingle()

  if (error) throw new Error(`project lookup failed: ${error.message}`)

  let project = existing ? {
    ...existing,
    external_links: asJsonRecord(existing.external_links),
    external_ids: asJsonRecord(existing.external_ids),
  } : null
  if (!project) {
    project = await discoverAndBackfillProject(d.safeName)
    if (!project) {
      console.warn(
        `[dropbox-watcher] no project (Supabase OR Frame.io) matches safeName=${d.safeName}`,
      )
      return
    }
    console.log(
      `[dropbox-watcher] auto-backfilled project ${project.id} for safeName=${d.safeName}`,
    )
  }

  // ── Respect the per-project Frame.io upload toggle ──────
  // A producer can disable Frame.io mirroring for projects that don't use
  // Frame.io for review ("@Kit turn off frame upload"). The delivery file stays
  // in Dropbox; we just don't mirror it. The check is before upload starts, so
  // a transcode already in flight still uploads — the toggle takes effect on
  // the next delivery.
  if (!(await isFrameioUploadEnabled(project.id))) {
    console.log(
      `[dropbox-watcher] Frame.io upload disabled for project ${project.id} (${project.name}); leaving ${d.name} in Dropbox only`,
    )
    return
  }

  const acct = process.env.FRAMEIO_ACCOUNT_ID
  if (!acct) throw new Error('FRAMEIO_ACCOUNT_ID required')

  // Sync/import can create a legitimate projects row before its Frame.io link
  // is known. Previously that partial row disabled discovery (discovery only ran
  // when NO project row existed), and returning here also advanced the Dropbox
  // cursor as though the delivery had succeeded. Self-heal the link by project
  // number, preserving every sibling external_links key, then continue with the
  // same delivery in this run.
  const frameioId = await resolveFrameioIdForProject(project, d.safeName, {
    findByProjectNumber: async (projectNumber) => {
      const ws = process.env.FRAMEIO_WORKSPACE_ID
      if (!ws) throw new Error('FRAMEIO_WORKSPACE_ID required')
      return findFrameioProjectByNumber(acct, ws, projectNumber)
    },
    persistLink: async (found) => {
      // Re-read immediately before the JSONB write so a concurrent updater does
      // not lose Slack/Dropbox/Harvest keys that changed after our first lookup.
      const { data: fresh, error: readErr } = await sb
        .from('projects')
        .select('external_links')
        .eq('id', project.id)
        .maybeSingle()
      if (readErr) throw new Error(`Frame.io link read failed: ${readErr.message}`)
      if (!fresh) throw new Error(`project ${project.id} disappeared while linking Frame.io`)

      const external_links = {
        ...asJsonRecord(fresh.external_links),
        frameio_id: found.id,
        frameio: frameioProjectUrl(found.id),
      }
      const { error: writeErr } = await sb
        .from('projects')
        .update({ external_links })
        .eq('id', project.id)
      if (writeErr) throw new Error(`Frame.io link write failed: ${writeErr.message}`)
    },
  })
  if (!frameioId) {
    // Throw rather than return: processDeltasOnce must count this delivery as a
    // failure and retain the Dropbox cursor for its retry pass.
    throw new Error(`project ${project.id} has no discoverable Frame.io project`)
  }

  // ── Resolve Frame.io destination folder ─────────────────
  const projResp = await frameioGet(`/accounts/${acct}/projects/${frameioId}`)
  const projData = projResp.data || projResp
  const rootFolderId = projData.root_folder_id || projData.root_asset_id
  if (!rootFolderId) throw new Error(`Frame.io project ${frameioId} has no root folder`)

  const outgoingId = await findChildFolder(acct, rootFolderId, '03_Outgoing')
  if (!outgoingId) throw new Error(`No 03_Outgoing under Frame.io project ${frameioId}`)

  const subId = await findChildFolder(acct, outgoingId, d.subfolder)
  if (!subId) throw new Error(`No "${d.subfolder}" subfolder under 03_Outgoing`)

  // ── Mirror any intermediate Dropbox subfolders ──────────
  // d.name is the path *under* the subfolder, so for a Dropbox file at
  //   .../09_Outgoing/02_Delivery/051326/v1/asset.mp4
  // d.name = "051326/v1/asset.mp4"
  // We walk the path, finding-or-creating each Frame.io folder, so the
  // file lands in the same hierarchy on Frame.io's side.
  const pathParts = d.name.split('/').filter(Boolean)
  const fileName = pathParts.pop() || d.name
  let targetFolderId = subId
  const traversedNames: string[] = []
  for (const folderName of pathParts) {
    let child = await findChildFolder(acct, targetFolderId, folderName)
    if (!child) {
      const created = await frameioPost(
        `/accounts/${acct}/folders/${targetFolderId}/folders`,
        { data: { name: folderName } },
      )
      child = (created.data || created).id
      console.log(
        `[dropbox-watcher] created Frame.io folder "${folderName}" under ${targetFolderId}`,
      )
    }
    if (!child) throw new Error(`Frame.io did not return a folder id for ${folderName}`)
    targetFolderId = child
    traversedNames.push(folderName)
  }

  // ── Resume an existing transfer or begin a new one ──────
  // A filename is presentation, never identity. The durable transfer ledger
  // binds this exact Dropbox file revision to the one Frame.io file created for
  // it. A same-name correction therefore cannot silently reuse stale media.
  // Check the ledger before reading Dropbox: after Frame.io accepts an upload,
  // producers may move/rename the source while Kit is waiting for processing.
  // Resuming that checkpoint must not depend on the old Dropbox path.
  const { data: priorTransfer, error: priorTransferError } = await sb
    .from('frameio_delivery_transfers')
    .select('*')
    .eq('project_id', project.id)
    .eq('dropbox_file_id', d.dropboxId)
    .eq('dropbox_rev', d.rev)
    .maybeSingle()
  if (priorTransferError) throw new Error(`Frame.io transfer lookup failed: ${priorTransferError.message}`)

  let transfer = priorTransfer as any
  let file: any
  if (!transfer) {
    // A new remote upload needs a short-lived Dropbox source URL. A resumed
    // transfer does not: Frame.io already owns its copy at that point.
    const tempLinkResp = await dbxPost('/files/get_temporary_link', { path: d.path })
    const sourceUrl: string = tempLinkResp.link
    if (!sourceUrl) throw new Error('Dropbox did not return a temporary link')

    const createResp = await frameioPost(
      `/accounts/${acct}/folders/${targetFolderId}/files/remote_upload`,
      { data: { name: fileName, source_url: sourceUrl } },
    )
    file = createResp.data || createResp
    const statusPath = createResp.links?.status ||
      `/accounts/${acct}/files/${file.id}/status`
    const viewUrl = file.view_url ||
      `https://next.frame.io/project/${frameioId}/view/${file.id}`
    const { data: insertedTransfer, error: transferError } = await sb
      .from('frameio_delivery_transfers')
      .insert({
        project_id: project.id,
        dropbox_file_id: d.dropboxId,
        dropbox_rev: d.rev,
        frameio_project_id: frameioId,
        frameio_folder_id: targetFolderId,
        frameio_file_id: file.id,
        frameio_status_path: statusPath,
        frameio_view_url: viewUrl,
        state: 'processing',
        last_provider_status: String(file.status || 'created'),
      })
      .select('*')
      .single()
    if (transferError) {
      throw new Error(`Frame.io accepted upload ${file.id}, but transfer checkpoint failed: ${transferError.message}`)
    }
    transfer = insertedTransfer
  } else {
    file = {
      id: transfer.frameio_file_id,
      view_url: transfer.frameio_view_url,
    }
  }

  // Remote upload is asynchronous. Never announce or create a review share
  // until Frame.io's documented status endpoint reports a terminal ready state.
  if (transfer.state !== 'ready') {
    let statusResp: unknown
    try {
      statusResp = await frameioGet(normalizeFrameioStatusPath(transfer.frameio_status_path))
    } catch (error) {
      // A remote-upload placeholder may be accepted before it is visible to
      // the status read path. Treat that eventual-consistency 404 exactly like
      // another non-terminal processing response during the bounded window.
      if (error instanceof FrameioApiError && error.status === 404) {
        deferFrameioProcessing(
          transfer.created_at,
          'Frame.io upload status is not visible yet (404); inbox will retry',
        )
      }
      throw error
    }
    const { readiness, providerStatus } = classifyFrameioUploadStatusResponse(statusResp)
    const { error: stateError } = await sb.from('frameio_delivery_transfers').update({
      state: readiness,
      last_provider_status: providerStatus || null,
      last_error: readiness === 'failed' ? `Frame.io upload ended in ${providerStatus || 'unknown failure'}` : null,
      updated_at: new Date().toISOString(),
    }).eq('id', transfer.id)
    if (stateError) throw new Error(`Frame.io transfer state checkpoint failed: ${stateError.message}`)
    if (readiness === 'failed') throw new Error(`Frame.io upload failed: ${providerStatus || 'unknown provider status'}`)
    if (readiness !== 'ready') {
      deferFrameioProcessing(
        transfer.created_at,
        `Frame.io upload is still processing (${providerStatus || 'pending'}); inbox will retry`,
      )
    }
    transfer.state = 'ready'
  }
  const breadcrumb =
    traversedNames.length > 0
      ? `03_Outgoing / ${d.subfolder} / ${traversedNames.join(' / ')}`
      : `03_Outgoing / ${d.subfolder}`
  console.log(
    `[dropbox-watcher] queued Frame.io upload for ${fileName} → ${project.name} / ${breadcrumb} (file id ${file.id})`,
  )

  // ── Create a Frame.io share link ────────────────────────
  // Frame.io v4 creates shares inside a project and accepts asset_ids in the
  // create payload. The account-level /share_links route never existed in v4.
  // If the create fails, fall back to the file's view_url (logged-in
  // Frame.io view) so the PM at least gets a working link.
  const shareName =
    traversedNames.length > 0
      ? `${d.subfolder} / ${traversedNames.join(' / ')} – ${fileName}`
      : `${d.subfolder} – ${fileName}`
  let reviewUrl: string | undefined = transfer.frameio_share_url || undefined
  try {
    if (reviewUrl) throw new Error('__share_already_checkpointed__')
    const shareRequest = buildFrameioShareRequest(
      acct,
      frameioId,
      file.id,
      shareName,
    )
    const linkResp = await frameioPost(shareRequest.path, shareRequest.body)
    const link = linkResp.data || linkResp
    reviewUrl =
      link.short_url || link.url || link.share_url || link.view_url
    if (!reviewUrl) throw new Error('Frame.io share response did not contain a URL')
    const { error: shareCheckpointError } = await sb.from('frameio_delivery_transfers')
      .update({ frameio_share_url: reviewUrl, updated_at: new Date().toISOString() })
      .eq('id', transfer.id).is('frameio_share_url', null)
    if (shareCheckpointError) throw new Error(`share checkpoint failed: ${shareCheckpointError.message}`)
    console.log(`[dropbox-watcher] share link created and checkpointed: ${reviewUrl}`)
  } catch (err: any) {
    if (err?.message !== '__share_already_checkpointed__') {
      console.warn(`[dropbox-watcher] share create failed (${err.message}); falling back to file view_url`)
    }
  }

  if (!reviewUrl) {
    reviewUrl =
      file.view_url ||
      `https://next.frame.io/project/${frameioId}/view/${file.id}`
  }
  if (!reviewUrl) throw new Error('Frame.io returned no review or view URL')

  let progression: RegisteredProjectShare | null = null
  try {
    const storedProjectNumber = asJsonRecord(project.external_ids).project_number
    const projectNumber = (typeof storedProjectNumber === 'string' ? storedProjectNumber : null) || extractProjectNumber(d.safeName) || String(project.project_code || '').split('-')[0] || ''
    progression = await registerProjectShare({
      projectId: project.id,
      projectNumber,
      dropboxFileId: d.dropboxId,
      dropboxRev: d.rev,
      fileName,
      shareUrl: reviewUrl,
    })
  } catch (err: any) {
    // The review upload is already successful; a Sheet/migration problem must
    // be visible but must never roll back or repeat the media upload.
    console.warn(`[dropbox-watcher] project-control share update failed: ${err.message}`)
  }

  const subfolderLine =
    traversedNames.length > 0
      ? `${d.subfolder} / ${traversedNames.join(' / ')}`
      : d.subfolder
  await notifyProjectShare(app, {
    project,
    fileName,
    reviewUrl,
    subfolderLine,
    progression,
  })
}

/** Retry the Sheet + Slack half of durable Frame.io share events. This closes
 * both crash windows: Frame upload succeeded but Google failed, or the Sheet
 * write succeeded but Slack notification did not. The ledger fields make the
 * sweep idempotent; successfully notified rows are no longer selected. */
export async function reconcilePendingProjectShares(
  app: App,
  limit = 20,
): Promise<{ scanned: number; recovered: number; failed: number }> {
  const sb = createAdminClient()
  const { data: events, error } = await sb.from('project_share_events')
    .select('id,project_id,file_name,share_url,suggested_milestone,match_confidence,slack_message_ts')
    .eq('status', 'pending')
    .is('slack_message_ts', null)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`pending project share scan failed: ${error.message}`)

  const tally = { scanned: events?.length || 0, recovered: 0, failed: 0 }
  for (const event of events || []) {
    try {
      const progression = await syncProjectShareEvent(event.id)
      if (!progression.eventId) continue
      const { data: project, error: projectError } = await sb.from('projects')
        .select('id,name,client,project_manager_slack_id,external_links')
        .eq('id', event.project_id)
        .maybeSingle()
      if (projectError || !project) throw new Error(projectError?.message || `Project not found: ${event.project_id}`)
      await notifyProjectShare(app, {
        project: { ...project, external_links: asJsonRecord(project.external_links) },
        fileName: event.file_name,
        reviewUrl: event.share_url,
        subfolderLine: '01_Client Progress / recovered share',
        progression,
        recovered: true,
      })
      tally.recovered++
      console.log(`[dropbox-watcher] recovered project share event ${event.id}`)
    } catch (err: any) {
      tally.failed++
      console.error(`[dropbox-watcher] project share recovery failed for ${event.id}: ${err.message}`)
    }
  }
  return tally
}

export interface FrameioShareBackfillTally {
  scanned: number
  backfilled: number
  noShares: number
  skipped: number
  failed: number
}

/**
 * Fill blank Last Share cells for projects that existed before Kit's durable
 * Dropbox→Frame.io share ledger. This is intentionally a backfill, not a
 * producer prompt: it never advances milestones and never re-announces old
 * deliveries in Slack. New uploads still use registerProjectShare immediately.
 */
export async function reconcileMissingFrameioLatestShares(limit = 100): Promise<FrameioShareBackfillTally> {
  const accountId = process.env.FRAMEIO_ACCOUNT_ID
  const config = workbookConfigFromEnv()
  if (!accountId || !config || config.layout !== 'rf-production-v1') {
    throw new Error('Frame.io account and Project Control workbook are required')
  }
  const sb = createAdminClient()
  const { data: projects, error } = await sb.from('projects')
    .select('id,project_code,external_ids,external_links')
    .in('status', ['active', 'partial', 'paused', 'on_hold'])
    .order('created_at', { ascending: false })
  if (error) throw new Error(`Frame.io share backfill project load failed: ${error.message}`)

  const tally: FrameioShareBackfillTally = { scanned: 0, backfilled: 0, noShares: 0, skipped: 0, failed: 0 }
  for (const project of projects || []) {
    if (tally.scanned >= limit) break
    const links = asJsonRecord(project.external_links)
    const ids = asJsonRecord(project.external_ids)
    const frameioProjectId = typeof links.frameio_id === 'string' ? links.frameio_id : ''
    const projectNumber = typeof ids.project_number === 'string'
      ? ids.project_number
      : extractProjectNumber(String(project.project_code || ''))
    if (!frameioProjectId || !projectNumber) {
      tally.skipped++
      continue
    }
    try {
      const current = await readLatestShare(config, project.id)
      if (!current || current.url) {
        tally.skipped++
        continue
      }
      tally.scanned++
      const latest = newestFrameioProjectShare(await listFrameioProjectShares(accountId, frameioProjectId))
      if (!latest) {
        tally.noShares++
        continue
      }
      const parsed = Date.parse(latest.createdAt)
      const date = Number.isFinite(parsed)
        ? new Date(parsed).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10)
      await recordLatestShare(config, project.id, { label: latest.name, url: latest.url, date })
      tally.backfilled++
    } catch (err: unknown) {
      tally.failed++
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[dropbox-watcher] Frame.io Last Share backfill failed for ${project.project_code || project.id}: ${message}`)
    }
  }
  if (tally.backfilled && !(await requestProjectControlSync(config, config.sheetId))) {
    console.warn('[dropbox-watcher] Last Share backfill refresh unavailable; cron will reconcile')
  }
  return tally
}

// ─── Discovery + auto-backfill ──────────────────────────────

/**
 * Pull the leading project number out of a safeName, regardless of casing
 * or separator. Examples:
 *   "2620_Microsoft_FoundryIQSizzle" → "2620"
 *   "2612B_Microsoft_D365 CI - ..."  → "2612B"
 *   "2620 Foundry IQ Sizzle"         → "2620"
 *
 * Uses an explicit "next char is non-alphanumeric or end" lookahead
 * rather than \b, because \b doesn't fire between "B" and "_" (both
 * are word chars to the regex engine).
 */
function extractProjectNumber(safeName: string): string | null {
  const m = safeName.match(/^(\d+[A-Za-z]?)(?=[^A-Za-z0-9]|$)/)
  return m ? m[1] : null
}

type FrameioProjectMatch = { id: string; name: string }

/**
 * Return a project's existing Frame.io id or discover and persist the missing
 * link. Kept dependency-injected so the partial-project regression is covered
 * without reaching Supabase or Frame.io in unit tests.
 */
export async function resolveFrameioIdForProject(
  project: { external_links?: Record<string, any> | null },
  safeName: string,
  deps: {
    findByProjectNumber: (projectNumber: string) => Promise<FrameioProjectMatch | null>
    persistLink: (found: FrameioProjectMatch) => Promise<void>
  },
): Promise<string | null> {
  const existing = project.external_links?.frameio_id
  if (typeof existing === 'string' && existing.trim()) return existing

  const projectNumber = extractProjectNumber(safeName)
  if (!projectNumber) return null

  const found = await deps.findByProjectNumber(projectNumber)
  if (!found) return null

  await deps.persistLink(found)
  return found.id
}

/**
 * Best-effort parse of an existing project label into the three fields
 * NOT NULL on `projects`: name, client, project_code. Used only when
 * inserting a discovered Frame.io project into Supabase.
 */
function deriveProjectFields(safeName: string, frameioName: string): {
  projectNumber: string
  client: string
  name: string
} {
  // Prefer the Frame.io project name as source of truth; fall back to safeName.
  const source = frameioName || safeName
  const parts = source.split('_').map((s) => s.trim()).filter(Boolean)
  const projectNumber = (extractProjectNumber(source) || parts[0] || '').trim()
  const client = (parts[1] || 'Unknown').trim()
  const name = parts.slice(2).join(' ').trim() || client
  return { projectNumber, client, name }
}

async function discoverAndBackfillProject(safeName: string): Promise<any | null> {
  const projectNumber = extractProjectNumber(safeName)
  if (!projectNumber) {
    console.warn(`[dropbox-watcher] could not extract project number from "${safeName}"`)
    return null
  }

  const acct = process.env.FRAMEIO_ACCOUNT_ID
  const ws = process.env.FRAMEIO_WORKSPACE_ID
  if (!acct || !ws) {
    console.warn('[dropbox-watcher] FRAMEIO_ACCOUNT_ID/WORKSPACE_ID missing; cannot discover')
    return null
  }

  const found = await findFrameioProjectByNumber(acct, ws, projectNumber)
  if (!found) {
    console.warn(
      `[dropbox-watcher] no Frame.io project starts with "${projectNumber}_" in workspace`,
    )
    return null
  }
  console.log(
    `[dropbox-watcher] discovery: ${safeName} → Frame.io project ${found.id} "${found.name}"`,
  )

  // Reuse the default Supabase workspace (single-tenant for this studio).
  const sb = createAdminClient()
  const { data: anyRow } = await sb
    .from('projects')
    .select('workspace_id')
    .limit(1)
    .maybeSingle()
  const workspaceId = anyRow?.workspace_id
  if (!workspaceId) {
    console.warn('[dropbox-watcher] no existing workspace_id in projects table; cannot backfill')
    return null
  }

  const fields = deriveProjectFields(safeName, found.name)
  const projectCode = `${fields.projectNumber}-${fields.client.replace(/\s+/g, '')}`

  // Insert a row capturing what we know. Future file drops for this
  // project will hit the Supabase lookup and skip discovery.
  const { data: inserted, error: insertErr } = await sb
    .from('projects')
    .insert({
      workspace_id: workspaceId,
      name: fields.name,
      client: fields.client,
      project_code: projectCode,
      status: 'active',
      external_ids: { dropbox_safe_name: safeName },
      external_links: { frameio_id: found.id, frameio: frameioProjectUrl(found.id) },
    })
    .select(
      'id, name, client, project_code, project_manager_slack_id, external_links, external_ids',
    )
    .single()

  if (insertErr) {
    console.error(`[dropbox-watcher] backfill insert failed: ${insertErr.message}`)
    return null
  }
  return inserted
}

async function findFrameioProjectByNumber(
  acct: string,
  ws: string,
  projectNumber: string,
): Promise<{ id: string; name: string } | null> {
  const projects = await listFrameioWorkspaceProjects(acct, ws)
  const resolved = selectFrameioProjectByNumber(projects, projectNumber)
  if (resolved.match) return resolved.match
  console.warn(
    `[dropbox-watcher] ${resolved.reason} Frame.io match for "${projectNumber}" after scanning ${projects.length}`,
  )
  return null
}

export function selectFrameioProjectByNumber(
  projects: FrameioProjectMatch[],
  projectNumber: string,
): { match: FrameioProjectMatch | null; reason: 'strict' | 'lenient' | 'none' | 'ambiguous' } {
  // Strict: project name starts with the number, followed by a separator
  // or end. Catches 99% of correctly-formatted projects.
  const startMatch = new RegExp(
    `^${projectNumber}(?=[^A-Za-z0-9]|$)`,
    'i',
  )
  // Lenient fallback: number appears anywhere in the name, surrounded by
  // non-alphanumerics on both sides. Used when no start-match is found
  // (e.g., the project's Frame.io name was set as "Microsoft - 2620 Foo"
  // instead of the studio's "2620_Microsoft_Foo" convention).
  const containsMatch = new RegExp(
    `(?:^|[^A-Za-z0-9])${projectNumber}(?=[^A-Za-z0-9]|$)`,
    'i',
  )

  const strict = projects.filter((p) => p.name && startMatch.test(p.name))
  if (strict.length === 1) return { match: strict[0], reason: 'strict' }
  if (strict.length > 1) return { match: null, reason: 'ambiguous' }

  const lenient = projects.filter((p) => p.name && containsMatch.test(p.name))
  if (lenient.length === 1) return { match: lenient[0], reason: 'lenient' }
  return { match: null, reason: lenient.length > 1 ? 'ambiguous' : 'none' }
}

async function listFrameioWorkspaceProjects(
  acct: string,
  ws: string,
): Promise<FrameioProjectMatch[]> {
  let url: string | null = `/accounts/${acct}/workspaces/${ws}/projects?page_size=100`
  let pages = 0
  const projects: FrameioProjectMatch[] = []

  while (url && pages++ < 20) {
    const r = await frameioGet(url)
    const items: any[] = r.data || r.projects || []
    for (const p of items) {
      if (p?.id && p?.name) projects.push({ id: p.id, name: p.name })
    }
    // Frame.io v4 pagination: try common shapes for the "next" cursor.
    const next =
      r.links?.next ||
      r.next_page ||
      r.pagination?.next ||
      r.pagination?.next_cursor ||
      null
    if (typeof next === 'string') {
      // Absolute URLs from Frame.io look like:
      //   https://api.frame.io/v4/accounts/.../projects?after=...
      // FRAMEIO_API already includes /v4, so we strip both the host and
      // the leading /v4 to avoid emitting /v4/v4/... and 404ing.
      let rel = next.startsWith('http') ? next.split('frame.io')[1] : next
      rel = rel.replace(/^\/v4(?=\/)/, '')
      url = rel || null
    } else {
      url = null
    }
  }
  return projects
}

export interface FrameioLinkReconcileTally {
  scanned: number
  linked: number
  notFound: number
  ambiguous: number
  skipped: number
}

/**
 * Reconcile active Kit projects that have a Dropbox identity but no Frame.io
 * identity. This removes the old dependency on waiting for a real outgoing file
 * before a partial imported project (for example 2633) becomes fully linked.
 * The workspace project list is fetched once per pass, and ambiguous project
 * numbers fail closed rather than attaching the wrong Frame.io project.
 */
export async function reconcileMissingFrameioProjectLinks(): Promise<FrameioLinkReconcileTally> {
  const acct = process.env.FRAMEIO_ACCOUNT_ID
  const ws = process.env.FRAMEIO_WORKSPACE_ID
  if (!acct || !ws) throw new Error('FRAMEIO_ACCOUNT_ID/FRAMEIO_WORKSPACE_ID required')

  const sb = createAdminClient()
  const { data: rows, error } = await sb
    .from('projects')
    .select('id, project_code, external_ids, external_links')
    .in('status', ['active', 'partial', 'paused'])
  if (error) throw new Error(`Frame.io reconcile project load failed: ${error.message}`)

  const candidates = (rows || []).filter((row) => {
    const ids = asJsonRecord(row.external_ids)
    const links = asJsonRecord(row.external_links)
    return Boolean(ids.dropbox_safe_name && (links.dropbox_id || links.dropbox) && !links.frameio_id)
  })
  const tally: FrameioLinkReconcileTally = {
    scanned: candidates.length,
    linked: 0,
    notFound: 0,
    ambiguous: 0,
    skipped: 0,
  }
  if (candidates.length === 0) return tally

  const frameioProjects = await listFrameioWorkspaceProjects(acct, ws)
  for (const row of candidates) {
    const safeNameValue = asJsonRecord(row.external_ids).dropbox_safe_name
    if (typeof safeNameValue !== 'string') {
      tally.skipped++
      continue
    }
    const safeName = safeNameValue
    const projectNumber = extractProjectNumber(safeName)
    if (!projectNumber) {
      tally.skipped++
      continue
    }
    const resolved = selectFrameioProjectByNumber(frameioProjects, projectNumber)
    if (!resolved.match) {
      if (resolved.reason === 'ambiguous') tally.ambiguous++
      else tally.notFound++
      continue
    }

    // Re-read immediately before the JSONB merge so a project update racing
    // this pass cannot lose sibling provider links or write a stale identity.
    const { data: fresh, error: readError } = await sb
      .from('projects')
      .select('external_links')
      .eq('id', row.id)
      .maybeSingle()
    if (readError) throw new Error(`Frame.io reconcile read failed: ${readError.message}`)
    const freshLinks = asJsonRecord(fresh?.external_links)
    if (!fresh || freshLinks.frameio_id) {
      tally.skipped++
      continue
    }
    const external_links = {
      ...freshLinks,
      frameio_id: resolved.match.id,
      frameio: frameioProjectUrl(resolved.match.id),
    }
    const { error: writeError } = await sb
      .from('projects')
      .update({ external_links, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    if (writeError) throw new Error(`Frame.io reconcile write failed: ${writeError.message}`)
    tally.linked++
    console.log(
      `[dropbox-watcher] reconciled ${row.project_code || row.id} → Frame.io ${resolved.match.id} "${resolved.match.name}"`,
    )
  }

  if (tally.linked || tally.ambiguous || tally.notFound) {
    console.log(
      `[dropbox-watcher] Frame.io reconcile done — scanned=${tally.scanned} linked=${tally.linked} ` +
        `notFound=${tally.notFound} ambiguous=${tally.ambiguous} skipped=${tally.skipped}`,
    )
  }
  return tally
}

// ─── Frame.io helpers ───────────────────────────────────────

class FrameioApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Frame.io ${method} ${path} ${status}: ${responseBody}`)
    this.name = 'FrameioApiError'
  }
}

export function shouldTimeoutFrameioProcessing(
  createdAt: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  const createdMs = Date.parse(String(createdAt || ''))
  return Number.isFinite(createdMs) && nowMs - createdMs >= FRAMEIO_PROCESSING_TIMEOUT_MS
}

function deferFrameioProcessing(createdAt: string | null | undefined, message: string): never {
  if (shouldTimeoutFrameioProcessing(createdAt)) {
    throw new Error(`${message.replace(/; inbox will retry$/, '')}; exceeded 24-hour processing window`)
  }
  throw new DropboxEventDeferred(message)
}

async function frameioGet(path: string): Promise<any> {
  const r = await fetch(`${FRAMEIO_API}${path}`, {
    headers: await frameioHeaders(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new FrameioApiError('GET', path, r.status, await r.text())
  return r.json()
}

async function frameioPost(path: string, body: any): Promise<any> {
  const r = await fetch(`${FRAMEIO_API}${path}`, {
    method: 'POST',
    headers: await frameioHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new FrameioApiError('POST', path, r.status, await r.text())
  return r.json()
}

async function findChildFolder(
  acct: string,
  parentId: string,
  name: string,
): Promise<string | null> {
  const r = await frameioGet(`/accounts/${acct}/folders/${parentId}/children`)
  const children = Array.isArray(r.data) ? r.data : Array.isArray(r) ? r : []
  for (const c of children) {
    const t = c.type || c.resource_type
    if (t === 'folder' && c.name === name) return c.id
  }
  return null
}

async function findChildFile(
  acct: string,
  parentId: string,
  name: string,
): Promise<any | null> {
  const r = await frameioGet(`/accounts/${acct}/folders/${parentId}/children`)
  const children = Array.isArray(r.data) ? r.data : Array.isArray(r) ? r : []
  for (const c of children) {
    const t = c.type || c.resource_type
    if (t === 'file' && c.name === name) return c
  }
  return null
}

export function normalizeFrameioStatusPath(path: string): string {
  // Frame.io returns this link as an absolute URL, `/v4/...`, or an already
  // base-relative `/accounts/...` path. The shared fail-closed normalizer
  // ensures FRAMEIO_API contributes exactly one `/v4` segment.
  return normalizeFrameioNextLink(path)
}

export function classifyFrameioUploadStatus(status: string): 'processing' | 'ready' | 'failed' {
  const value = String(status || '').trim().toLowerCase()
  if (['failed', 'error', 'cancelled', 'canceled'].includes(value)) return 'failed'
  if (['ready', 'complete', 'completed', 'uploaded', 'processed', 'transcoded'].includes(value)) return 'ready'
  return 'processing'
}

/** Frame.io's upload-status endpoint reports upload_complete/upload_failed
 * booleans, while file resources report a string status. Support both shapes
 * because the remote-upload status link returns the former. */
export function classifyFrameioUploadStatusResponse(response: unknown): {
  readiness: 'processing' | 'ready' | 'failed'
  providerStatus: string
} {
  const outer = response && typeof response === 'object'
    ? response as Record<string, unknown>
    : {}
  const data = outer.data && typeof outer.data === 'object'
    ? outer.data as Record<string, unknown>
    : outer
  if (data.upload_failed === true) return { readiness: 'failed', providerStatus: 'failed' }
  if (data.upload_complete === true) return { readiness: 'ready', providerStatus: 'completed' }

  const providerStatus = String(data.status || data.state || '').trim().toLowerCase()
  if (data.upload_complete === false && !providerStatus) {
    return { readiness: 'processing', providerStatus: 'pending' }
  }
  return {
    readiness: classifyFrameioUploadStatus(providerStatus),
    providerStatus: providerStatus || 'pending',
  }
}
