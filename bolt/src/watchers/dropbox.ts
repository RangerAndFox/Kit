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

  // ── Create a review link (file may still be processing) ─
  // The review link is valid even while the asset transcodes.
  const reviewLinkName =
    traversedNames.length > 0
      ? `${d.subfolder} / ${traversedNames.join(' / ')} – ${fileName}`
      : `${d.subfolder} – ${fileName}`
  let reviewUrl: string | undefined
  try {
    const linkResp = await frameioPost(
      `/accounts/${acct}/projects/${frameioId}/review_links`,
      {
        data: {
          name: reviewLinkName,
          items: [{ file_id: file.id }],
        },
      },
    )
    const link = linkResp.data || linkResp
    reviewUrl = link.review_url || link.short_url || link.url
  } catch (err: any) {
    console.warn(`[dropbox-watcher] review link failed: ${err.message}`)
  }

  // ── Notify ──────────────────────────────────────────────
  // Preference order:
  //   1. DM the project's PM if we have one
  //   2. Post in the project's Slack channel if linked
  //   3. DM the fallback user (KIT_FALLBACK_PM_SLACK_ID)
  //   4. Skip silently
  const linkLine = reviewUrl ? `<${reviewUrl}|Open review on Frame.io>` : '_(no review link)_'
  const subfolderLine =
    traversedNames.length > 0
      ? `${d.subfolder} / ${traversedNames.join(' / ')}`
      : d.subfolder
  const text =
    `📦 *New delivery for ${project.name}* (${project.client})\n` +
    `• Subfolder: \`${subfolderLine}\`\n` +
    `• File: \`${fileName}\`\n` +
    `• ${linkLine}`

  const pmId: string | undefined = project.project_manager_slack_id
  const channelId: string | undefined = project.external_links?.slack_id
  const fallbackPm = process.env.KIT_FALLBACK_PM_SLACK_ID
  const target = pmId || channelId || fallbackPm

  if (!target) {
    console.warn(
      `[dropbox-watcher] project ${project.id} has no PM, no Slack channel, and no KIT_FALLBACK_PM_SLACK_ID set; skipping notification`,
    )
    return
  }

  await app.client.chat.postMessage({
    channel: target,
    text: `📦 New delivery for *${project.name}*`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  })
  console.log(
    `[dropbox-watcher] notified ${pmId ? `PM ${pmId}` : channelId ? `channel ${channelId}` : `fallback ${fallbackPm}`}`,
  )
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
      external_links: { frameio_id: found.id, frameio: `https://app.frame.io/projects/${found.id}` },
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

  let url: string | null =
    `/accounts/${acct}/workspaces/${ws}/projects?page_size=100`
  let pages = 0
  let totalScanned = 0
  const sampleNames: string[] = []
  let lenientHit: { id: string; name: string } | null = null

  while (url && pages++ < 20) {
    const r = await frameioGet(url)
    const items: any[] = r.data || r.projects || []
    if (pages === 1) {
      console.log(
        `[dropbox-watcher] frameio list response shape: top-keys=[${Object.keys(r).join(',')}] item-keys=[${items[0] ? Object.keys(items[0]).join(',') : 'empty'}]`,
      )
    }
    for (const p of items) {
      totalScanned++
      if (sampleNames.length < 6 && p.name) sampleNames.push(p.name)
      if (p.name && startMatch.test(p.name)) {
        console.log(
          `[dropbox-watcher] frameio search hit (start-match) after scanning ${totalScanned}: "${p.name}"`,
        )
        return { id: p.id, name: p.name }
      }
      if (!lenientHit && p.name && containsMatch.test(p.name)) {
        lenientHit = { id: p.id, name: p.name }
      }
    }
    // Frame.io v4 pagination: try common shapes. Logs first response
    // shape above so we can correct this if needed.
    const next =
      r.links?.next ||
      r.next_page ||
      r.pagination?.next ||
      r.pagination?.next_cursor ||
      null
    url =
      typeof next === 'string'
        ? next.startsWith('http')
          ? next.split('frame.io')[1]
          : next
        : null
  }

  if (lenientHit) {
    console.log(
      `[dropbox-watcher] frameio search hit (contains-match fallback) after scanning ${totalScanned}: "${lenientHit.name}"`,
    )
    return lenientHit
  }

  console.warn(
    `[dropbox-watcher] frameio search: scanned ${totalScanned} projects, no match for "${projectNumber}". Sample names: ${sampleNames.join(' | ')}`,
  )
  return null
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
