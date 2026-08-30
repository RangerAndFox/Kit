// @ts-nocheck
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
import { frameioProjectUrl } from '../../../src/lib/frameio/url'
import { isFrameioUploadEnabled } from '../../../src/lib/projects/settings'
import { processSrtFile } from '../../../src/lib/delivery/subtitle-watcher'
import {
  registerProjectShare,
  syncProjectShareEvent,
  type RegisteredProjectShare,
} from '../../../src/lib/project-control/share-progress'

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

/** A Dropbox revision is acknowledged only after every matched side effect
 * succeeds. Poison entries must be dead-lettered durably before any future
 * implementation advances past them; process memory is not a safe ledger. */
export function shouldAdvanceDeliveryCursor(failedEntries: number): boolean {
  return failedEntries === 0
}

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
    return
  }

  const { entries, newCursor } = await fetchDeltas(cursor)

  let matched = 0
  let failed = 0
  for (const entry of entries) {
    if (entry.tag !== 'file') continue

    // Accessibility SRT → generate TTML/VTT/TXT siblings in the same folder.
    // Checked before PATH_RE (captions live in an accessibility folder, not
    // 09_Outgoing). Our own .ttml/.vtt/.txt uploads don't re-match (not .srt).
    const accSafeName = matchAccessibilitySrt(entry.path_display)
    if (accSafeName) {
      matched++
      try {
        await handleAccessibilitySrt(app, {
          path: entry.path_display,
          safeName: accSafeName,
          sizeBytes: entry.size || 0,
        })
      } catch (err: any) {
        failed++
        console.error(`[dropbox-watcher] accessibility SRT failed for ${entry.path_display}: ${err.message}`)
      }
      continue
    }

    // AE render-farm watch folder: an .aep in 08_AE/03_RenderFarm → submit to
    // the Deadline farm. Checked before PATH_RE (different subtree).
    const aeDrop = matchAeRenderFarmDrop(entry.path_display)
    if (aeDrop) {
      matched++
      try {
        await handleAeRenderFarmDrop(app, {
          ...aeDrop,
          dropboxId: entry.id || entry.path_lower,
          rev: entry.rev || '',
        })
      } catch (err: any) {
        failed++
        console.error(`[dropbox-watcher] AE render drop failed for ${entry.path_display}: ${err.message}`)
      }
      continue
    }

    const m = entry.path_display.match(PATH_RE)
    if (!m) continue
    const [, year, safeName, subfolder, filename] = m
    // Skip denied file types (e.g. .aac audio sidecars) so they aren't
    // mirrored to Frame.io alongside the video deliverables.
    if (isDeniedDeliveryFile(filename)) {
      console.log(`[dropbox-watcher] skipping ${entry.path_display} (denied extension)`)
      continue
    }
    matched++
    try {
      await handleNewDelivery(app, {
        path: entry.path_display,
        name: filename,
        safeName,
        subfolder,
        year,
        dropboxId: entry.id || entry.path_lower,
        rev: entry.rev || '',
      })
      // Celebrate a real delivery (02_Delivery only) with a meme in the team
      // channel — one per project per day (deduped downstream). Fire-and-forget
      // so it can never slow or break the delivery mirror.
      if (/02_Delivery/i.test(subfolder)) {
        const projectName =
          safeName.replace(/^\d+[A-Za-z]?[_-]/, '').replace(/[_-]+/g, ' ').trim() || safeName
        import('../celebrations/celebrations')
          .then(({ postDeliveryCelebration }) => postDeliveryCelebration(app, projectName))
          .catch((e) => console.warn(`[dropbox-watcher] delivery celebration failed: ${e?.message || e}`))
      }
    } catch (err: any) {
      failed++
      console.error(`[dropbox-watcher] failed for ${entry.path_display}: ${err.message}`)
    }
  }

  // Advance the cursor only after processing, and only if the batch didn't
  // fail — saving it up front permanently consumes the delta. Never advance
  // merely because the same cursor failed twice; that permanently loses the
  // client delivery after a provider outage or process restart.
  if (shouldAdvanceDeliveryCursor(failed)) {
    await saveCursor(newCursor)
  } else {
    console.error(
      `[dropbox-watcher] ${failed}/${matched} deliveries failed — cursor NOT advanced; batch retries on the next notification`,
    )
  }

  console.log(
    `[dropbox-watcher] processed ${entries.length} entries, ${matched} matched outgoing pattern`,
  )
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
  external_links?: Record<string, any> | null
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
  return data?.external_links?.slack_id || data?.external_links?.slack_channel_id || null
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

  let project = existing
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
        ...(fresh.external_links || {}),
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
    targetFolderId = child
    traversedNames.push(folderName)
  }

  // ── Get a temporary Dropbox download URL ────────────────
  const tempLinkResp = await dbxPost('/files/get_temporary_link', { path: d.path })
  const sourceUrl: string = tempLinkResp.link
  if (!sourceUrl) throw new Error('Dropbox did not return a temporary link')

  // ── Idempotency: reuse if this file was already mirrored ─
  // Dropbox can replay the same delta (duplicate webhooks, a reprocessed
  // batch). Do not upload a second copy, but DO reconcile the durable share
  // event + Sheet state. The old early return made a transient Sheet failure
  // permanent once Frame.io already had the asset.
  try {
    const existingFile = await findChildFile(acct, targetFolderId, fileName)
    if (existingFile) {
      const existingReviewUrl = existingFile.view_url ||
        `https://next.frame.io/project/${frameioId}/view/${existingFile.id}`
      const projectNumber = project.external_ids?.project_number || extractProjectNumber(d.safeName) || String(project.project_code || '').split('-')[0]
      const progression = await registerProjectShare({
        projectId: project.id,
        projectNumber,
        dropboxFileId: d.dropboxId,
        dropboxRev: d.rev,
        fileName,
        shareUrl: existingReviewUrl,
      })
      const subfolderLine = traversedNames.length > 0
        ? `${d.subfolder} / ${traversedNames.join(' / ')}`
        : d.subfolder
      await notifyProjectShare(app, {
        project,
        fileName,
        reviewUrl: existingReviewUrl,
        subfolderLine,
        progression,
        recovered: true,
      })
      console.log(
        `[dropbox-watcher] ${fileName} already in ${project.name} / ${d.subfolder} (file ${existingFile.id}); reconciled without re-upload`,
      )
      return
    }
  } catch (err: any) {
    console.warn(
      `[dropbox-watcher] existing-file check failed for ${fileName} (continuing): ${err.message}`,
    )
  }

  // ── Hand it to Frame.io remote_upload ───────────────────
  // Frame.io v4 remote_upload accepts a source_url and pulls async.
  const createResp = await frameioPost(
    `/accounts/${acct}/folders/${targetFolderId}/files/remote_upload`,
    {
      data: {
        name: fileName,
        source_url: sourceUrl,
      },
    },
  )
  const file = createResp.data || createResp
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
  let reviewUrl: string | undefined
  try {
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
    console.log(`[dropbox-watcher] share link created: ${reviewUrl}`)
  } catch (err: any) {
    console.warn(
      `[dropbox-watcher] share create failed (${err.message}); falling back to file view_url`,
    )
  }

  if (!reviewUrl) {
    reviewUrl =
      file.view_url ||
      `https://next.frame.io/project/${frameioId}/view/${file.id}`
  }

  let progression: RegisteredProjectShare | null = null
  try {
    const projectNumber = project.external_ids?.project_number || extractProjectNumber(d.safeName) || String(project.project_code || '').split('-')[0]
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
        project,
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

  const candidates = (rows || []).filter(
    (row: any) =>
      row.external_ids?.dropbox_safe_name &&
      (row.external_links?.dropbox_id || row.external_links?.dropbox) &&
      !row.external_links?.frameio_id,
  )
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
    const safeName = row.external_ids.dropbox_safe_name as string
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
    if (!fresh || fresh.external_links?.frameio_id) {
      tally.skipped++
      continue
    }
    const external_links = {
      ...(fresh.external_links || {}),
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

async function frameioGet(path: string): Promise<any> {
  const r = await fetch(`${FRAMEIO_API}${path}`, {
    headers: await frameioHeaders(),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error(`Frame.io GET ${path} ${r.status}: ${await r.text()}`)
  return r.json()
}

async function frameioPost(path: string, body: any): Promise<any> {
  const r = await fetch(`${FRAMEIO_API}${path}`, {
    method: 'POST',
    headers: await frameioHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error(`Frame.io POST ${path} ${r.status}: ${await r.text()}`)
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
