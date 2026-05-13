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

const DROPBOX_API = 'https://api.dropboxapi.com/2'
const FRAMEIO_API = 'https://api.frame.io/v4'

const WATCH_ROOT = '/production'

// Match `/production/<year>/<safeName>/09_Outgoing/(01_Client Progress|02_Delivery)/<filename>`
// path_display preserves the original casing.
const PATH_RE = /^\/production\/(\d{4})\/([^/]+)\/09_Outgoing\/(01_Client Progress|02_Delivery)\/(.+)$/i

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
  const { data } = await sb
    .from('dropbox_state')
    .select('cursor')
    .eq('id', 'singleton')
    .single()
  return data?.cursor || null
}

async function saveCursor(cursor: string): Promise<void> {
  const sb = createAdminClient()
  await sb
    .from('dropbox_state')
    .update({ cursor, updated_at: new Date().toISOString() })
    .eq('id', 'singleton')
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
      })
    }
    cursor = r.cursor
    if (!r.has_more) break
  }
  return { entries, newCursor: cursor }
}

// ─── Main entrypoint ────────────────────────────────────────

export async function processDropboxNotification(app: App): Promise<void> {
  let cursor = await loadCursor()
  if (!cursor) {
    await seedCursor()
    console.log('[dropbox-watcher] seeded cursor on first run; no deltas to process')
    return
  }

  const { entries, newCursor } = await fetchDeltas(cursor)
  await saveCursor(newCursor)

  let matched = 0
  for (const entry of entries) {
    if (entry.tag !== 'file') continue
    const m = entry.path_display.match(PATH_RE)
    if (!m) continue
    matched++
    const [, year, safeName, subfolder, filename] = m
    try {
      await handleNewDelivery(app, {
        path: entry.path_display,
        name: filename,
        safeName,
        subfolder,
        year,
      })
    } catch (err: any) {
      console.error(`[dropbox-watcher] failed for ${entry.path_display}: ${err.message}`)
    }
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
}

async function handleNewDelivery(app: App, d: Delivery): Promise<void> {
  // ── Lookup project ───────────────────────────────────────
  const sb = createAdminClient()
  const { data: project, error } = await sb
    .from('projects')
    .select(
      'id, name, client, project_code, project_manager_slack_id, external_links, external_ids',
    )
    .filter('external_ids->>dropbox_safe_name', 'eq', d.safeName)
    .maybeSingle()

  if (error) throw new Error(`project lookup failed: ${error.message}`)
  if (!project) {
    console.warn(`[dropbox-watcher] no project matches safeName=${d.safeName}`)
    return
  }

  const frameioId = project.external_links?.frameio_id
  if (!frameioId) {
    console.warn(`[dropbox-watcher] project ${project.id} missing external_links.frameio_id`)
    return
  }

  // ── Resolve Frame.io destination folder ─────────────────
  const acct = process.env.FRAMEIO_ACCOUNT_ID
  if (!acct) throw new Error('FRAMEIO_ACCOUNT_ID required')

  const projResp = await frameioGet(`/accounts/${acct}/projects/${frameioId}`)
  const projData = projResp.data || projResp
  const rootFolderId = projData.root_folder_id || projData.root_asset_id
  if (!rootFolderId) throw new Error(`Frame.io project ${frameioId} has no root folder`)

  const outgoingId = await findChildFolder(acct, rootFolderId, '03_Outgoing')
  if (!outgoingId) throw new Error(`No 03_Outgoing under Frame.io project ${frameioId}`)

  const subId = await findChildFolder(acct, outgoingId, d.subfolder)
  if (!subId) throw new Error(`No "${d.subfolder}" subfolder under 03_Outgoing`)

  // ── Get a temporary Dropbox download URL ────────────────
  const tempLinkResp = await dbxPost('/files/get_temporary_link', { path: d.path })
  const sourceUrl: string = tempLinkResp.link
  if (!sourceUrl) throw new Error('Dropbox did not return a temporary link')

  // ── Hand it to Frame.io remote_upload ───────────────────
  // Frame.io v4 remote_upload accepts a source_url and pulls async.
  const createResp = await frameioPost(
    `/accounts/${acct}/folders/${subId}/files/remote_upload`,
    {
      data: {
        name: d.name,
        source_url: sourceUrl,
      },
    },
  )
  const file = createResp.data || createResp
  console.log(
    `[dropbox-watcher] queued Frame.io upload for ${d.name} → ${project.name} / 03_Outgoing / ${d.subfolder} (file id ${file.id})`,
  )

  // ── Create a review link (file may still be processing) ─
  // The review link is valid even while the asset transcodes.
  let reviewUrl: string | undefined
  try {
    const linkResp = await frameioPost(
      `/accounts/${acct}/projects/${frameioId}/review_links`,
      {
        data: {
          name: `${d.subfolder} – ${d.name}`,
          items: [{ file_id: file.id }],
        },
      },
    )
    const link = linkResp.data || linkResp
    reviewUrl = link.review_url || link.short_url || link.url
  } catch (err: any) {
    console.warn(`[dropbox-watcher] review link failed: ${err.message}`)
  }

  // ── DM the PM ───────────────────────────────────────────
  const pmId = project.project_manager_slack_id
  if (!pmId) {
    console.warn(`[dropbox-watcher] project ${project.id} has no PM Slack id; skipping DM`)
    return
  }

  const linkLine = reviewUrl ? `<${reviewUrl}|Open review on Frame.io>` : '_(no review link)_'
  await app.client.chat.postMessage({
    channel: pmId,
    text: `📦 New delivery for *${project.name}*`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `📦 *New delivery for ${project.name}* (${project.client})\n` +
            `• Subfolder: \`${d.subfolder}\`\n` +
            `• File: \`${d.name}\`\n` +
            `• ${linkLine}`,
        },
      },
    ],
  })
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
