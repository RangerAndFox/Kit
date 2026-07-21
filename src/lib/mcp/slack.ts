// @ts-nocheck
/**
 * Lightweight Slack channel creation for MCP tool use.
 * Reuses the same Slack API pattern as the provisioner but takes
 * simple project fields instead of a full ProjectIntakeForm.
 */

import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

const SLACK_API = 'https://slack.com/api'

// Slack canvas downloads come back as Quip-flavored HTML (canvases run on
// Quip under the hood). canvases.create accepts markdown, so we convert
// HTML → markdown before posting. Tables need the GFM plugin.
const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  hr: '---', // not '* * *' — Slack canvas's parser only recognizes ---
})
turndown.use(gfm)

// Slack canvas markdown is stricter than CommonMark/GFM. Turndown emits a
// few things that either trip canvases.create or — more commonly — render
// differently from the source template, which is what we're correcting for:
//   - escaped brackets: \[Foo\] (turndown protects link syntax). Slack
//     treats the backslash as literal.
//   - escaped underscores: telephone\_receiver. Breaks emoji shortcodes and
//     shows a literal backslash.
//   - escaped pipes: "## Email \| 05.01" — turndown's GFM plugin escapes
//     every pipe to protect table syntax, but a pipe in a HEADING or
//     paragraph should stay literal.
//
// Emoji shortcodes (:email:, :figma:, :microsoft-word:) are LEFT INTACT —
// Slack canvases render them natively, so keeping the shortcode reproduces
// the template's exact icon. We used to convert known ones to Unicode
// glyphs, but that swapped the icon style and made clones look different
// from the template. The only real cause of literal-text rendering was the
// escaped underscore, which we now unescape below.
export function sanitizeCanvasMarkdown(md: string): string {
  let s = md
  // Unescape brackets — Slack canvas treats \[ as a literal backslash
  // followed by a bracket, not as an escaped bracket.
  s = s.replace(/\\\[/g, '[').replace(/\\\]/g, ']')
  // Unescape underscores so "telephone_receiver" and :telephone_receiver:
  // come through clean.
  s = s.replace(/\\_/g, '_')
  // Unescape pipes — but only on lines that aren't GFM table rows, since a
  // table cell legitimately needs an escaped pipe. Headings / paragraphs
  // (e.g. "## :email: Email note from client | 05.01") must keep the literal.
  s = s
    .split('\n')
    .map((line) => (line.trimStart().startsWith('|') ? line : line.replace(/\\\|/g, '|')))
    .join('\n')
  // Tidy trailing whitespace; collapse runs of spaces (no effect on the
  // already-unaligned canvas tables).
  s = s.replace(/[ \t]+\n/g, '\n').replace(/  +/g, ' ')
  return s
}

// Quip canvas HTML has a few non-standard wrappers that confuse turndown:
//   - <control id="..." data-remapped="true">text</control> — date controls,
//     emoji controls, etc. We just want the inner text.
//   - <img alt=":emoji_name:" src="...">:emoji_name:</img> — Quip emojis are
//     emitted as <img> with both an alt attr AND inner text holding the
//     shortcode, plus a non-standard closing </img>. Collapse the whole
//     thing (open tag + inner + close) to a single :emoji_name:.
//   - <lnk href="...">text</lnk> — Quip's non-standard link tag.
//   - Tables come back as <table><tr><td>...</td></tr>...</table>
//     with no <th>/<thead>. turndown-plugin-gfm needs <th> to recognize a
//     table, so we promote each table's first row of <td>s to <th>s.
//   - Inside cells: block-level <h1>-<h6>, <p>, <div>, <ul>/<ol>/<li> all
//     emit newlines in turndown, which shatters GFM pipe-tables (each cell
//     must fit on one line). We flatten them to inline.
function preprocessCanvasHtml(html: string): string {
  let s = html

  // <img ... alt="X" ...>...optional inner...</img>  →  :X:
  s = s.replace(
    /<img\b[^>]*\balt="([^"]+)"[^>]*>(?:[\s\S]*?<\/img>)?/gi,
    ':$1:',
  )

  // Any leftover stray </img> tags from Quip output.
  s = s.replace(/<\/img>/gi, '')

  // <control ...>inner</control>  →  inner.
  s = s.replace(/<control\b[^>]*>([\s\S]*?)<\/control>/gi, '$1')

  // <lnk href="...">text</lnk> → text. Quip's non-standard link tag.
  s = s.replace(/<lnk\b[^>]*>([\s\S]*?)<\/lnk>/gi, '$1')

  // Drop wrapper <div class="quip-canvas-content"> and any other divs.
  s = s.replace(/<\/?div\b[^>]*>/gi, '')

  // Drop entirely-empty <p class="line"></p> placeholders. The template
  // ships ~80 of these after the content; they round-trip through turndown
  // as blank lines that just add noise without any structural meaning.
  s = s.replace(/<p\b[^>]*>\s*<\/p>/gi, '')

  // Promote first <tr>'s <td>s to <th>s so turndown-plugin-gfm recognizes
  // these as GFM tables, then flatten every cell's inner content to a
  // single inline string (no block tags).
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_match, inner) => {
    let firstRowSeen = false
    let rewritten = inner.replace(
      /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi,
      (rowMatch: string, rowInner: string) => {
        if (firstRowSeen) return rowMatch
        firstRowSeen = true
        const headered = rowInner
          .replace(/<td\b/gi, '<th')
          .replace(/<\/td>/gi, '</th>')
        return rowMatch.replace(rowInner, headered)
      },
    )
    rewritten = rewritten.replace(
      /<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi,
      (_m: string, tag: string, cellInner: string) => {
        let flat = cellInner
          // <li>X</li> → "X, ". Joining multi-item lists in a cell as a
          // comma list keeps the cell on one line (Audio Descripion MP3,
          // SRT, TTML, TXT, VTT) instead of newline-separated bullets.
          .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '$1, ')
          // Drop list wrappers and span wrappers — keep inner text.
          .replace(/<\/?(?:ul|ol|span)\b[^>]*>/gi, '')
          // Strip headings (<h1>..<h6>) — keep inner text only, no markdown
          // heading syntax inside a table cell.
          .replace(/<\/?h[1-6]\b[^>]*>/gi, '')
          // Flatten paragraphs and line breaks.
          .replace(/<p\b[^>]*>/gi, '')
          .replace(/<\/p>/gi, ' ')
          .replace(/<br\s*\/?>/gi, ' ')
          // Collapse whitespace and trim trailing punctuation from list join.
          .replace(/\s+/g, ' ')
          .replace(/,\s*$/, '')
          .trim()
        return `<${tag}>${flat}</${tag}>`
      },
    )
    return `<table>${rewritten}</table>`
  })

  return s
}

function canvasHtmlToMarkdown(html: string): string {
  const raw = turndown.turndown(preprocessCanvasHtml(html))
  return sanitizeCanvasMarkdown(raw).trim()
}

/**
 * Fill the template canvas's project-metadata table with known values.
 *
 * The R&F template has label rows with an empty value cell:
 *   |### **Client**||       (top metadata table)
 *   |### **Producer**||
 *   |### Dropbox||          (Assets Folders table)
 *   |### [Frame.io](…)||
 * (after HTML→markdown conversion these become GFM rows like
 *  `| ### **Client** |  |`).
 *
 * We normalize each row's first (label) cell — collapsing markdown links
 * to their text, stripping #, *, emoji, dots, date/image tokens,
 * whitespace — and match it against the known fields.
 * The value drops into the empty trailing cell. Rules that keep this safe:
 *   - Only EMPTY value cells are filled (never overwrite manual edits).
 *   - Each field fills at most ONCE (the metadata table is at the top, so
 *     it wins over later rows like the "Delivery" milestone or
 *     "Client Figma" / "Delivery Files" which normalize differently anyway).
 *   - If the converter produced something we don't recognize, every row
 *     just passes through untouched — the canvas is created exactly as
 *     before, so this can only add information, never break the copy.
 */
export function fillCanvasTemplate(
  markdown: string,
  fields: {
    client?: string
    projectType?: string
    producer?: string
    cd?: string
    delivery?: string
    dropbox?: string
    frameio?: string
    headerTitle?: string
  },
): string {
  const norm = (s: string) =>
    s
      .replace(/!\[\]\([^)]*\)/g, '') // strip ![](slack_date:…) / image tokens
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [Frame.io](url) -> Frame.io
      .replace(/[#*`>_~:|.]/g, '') // incl. dots so "Frame.io" -> "frameio"
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()

  const wanted: Array<{ key: string; value: string; done: boolean }> = []
  const add = (label: string, value?: string) => {
    if (value && value.trim()) wanted.push({ key: norm(label), value: value.trim(), done: false })
  }
  add('Client', fields.client)
  add('Project Type', fields.projectType)
  add('Producer', fields.producer)
  add('CD', fields.cd)
  add('Delivery', fields.delivery)
  add('Dropbox', fields.dropbox)
  add('Frame.io', fields.frameio)

  const filled = markdown
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return line
      const cells = trimmed.slice(1, -1).split('|')
      if (cells.length < 2) return line
      const labelKey = norm(cells[0])
      if (!labelKey) return line
      const w = wanted.find((x) => !x.done && x.key === labelKey)
      if (!w) return line
      const lastIdx = cells.length - 1
      if (cells[lastIdx].trim() !== '') return line // already has a value
      cells[lastIdx] = ` ${w.value} `
      w.done = true
      const indent = line.slice(0, line.indexOf('|'))
      return `${indent}|${cells.join('|')}|`
    })
    .join('\n')

  // Replace the placeholder H1 ("# 🎬 2xxx Client Project") with the real spine.
  if (fields.headerTitle && fields.headerTitle.trim()) {
    return filled.replace(/2x{2,}\s+client\s+project/i, fields.headerTitle.trim())
  }
  return filled
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    'Content-Type': 'application/json; charset=utf-8',
  }
}

// Bounded: an unbounded Slack call could hang past a provisioning/creation lease
// and let a reclaiming worker run concurrently.
const SLACK_CALL_TIMEOUT_MS = 15_000

async function slackPost(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SLACK_CALL_TIMEOUT_MS),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`)
  return data
}

// Some Slack read methods (conversations.info, files.info) reject JSON bodies
// with `invalid_arguments` and only reliably accept GET with query-string params.
async function slackGet(method: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${SLACK_API}/${method}?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    signal: AbortSignal.timeout(SLACK_CALL_TIMEOUT_MS),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`)
  return data
}

/** Embedded stable Kit identity marker, written into a project channel's purpose. */
export function kitChannelMarker(projectId: string): string {
  return `[kit:${projectId}]`
}

/**
 * Reconcile a project channel by name, confirming it is OURS via the embedded
 * Kit marker in its purpose. Lets a resumed provision reuse the channel a prior
 * attempt created (which would otherwise trip `name_taken` and spawn a suffixed
 * duplicate). Bounded pagination. Returns the channel id or null.
 */
async function findOwnedChannelByName(slug: string, projectId: string): Promise<string | null> {
  if (!projectId) return null
  const marker = kitChannelMarker(projectId)
  let cursor = ''
  for (let page = 0; page < 10; page++) {
    const params: Record<string, string> = {
      types: 'public_channel',
      exclude_archived: 'false',
      limit: '1000',
    }
    if (cursor) params.cursor = cursor
    const res = await slackGet('conversations.list', params).catch(() => null)
    if (!res) return null
    type ChannelLite = { id?: string; name?: string; purpose?: { value?: string } }
    const match = ((res.channels || []) as ChannelLite[]).find(
      (c) => c?.name === slug && (c?.purpose?.value || '').includes(marker),
    )
    if (match) return match.id ?? null
    cursor = res.response_metadata?.next_cursor || ''
    if (!cursor) break
  }
  return null
}


export interface SlackChannelResult {
  channelId: string
  channelName: string
  url: string
}

/**
 * Creates a Slack channel for a project, sets the topic, and posts
 * a welcome message. Returns the channel ID and URL.
 *
 * Channel naming: {client}-{project-name} slugified, max 80 chars.
 * If channel already exists (name_taken error), appends project ID suffix.
 */
/**
 * Invite users to a channel without letting one bad ID sink the whole batch.
 * Tries a single batch invite first (the happy path); if that fails, falls back
 * to per-user invites so the valid members still get added. `already_in_channel`
 * counts as success (idempotent).
 */
export async function inviteUsersToChannel(
  channelId: string,
  userIds: string[],
): Promise<{ invited: string[]; failed: Array<{ id: string; error: string }> }> {
  const invited: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  if (!channelId || userIds.length === 0) return { invited, failed }

  // Happy path: one call for everyone.
  try {
    await slackPost('conversations.invite', { channel: channelId, users: userIds.join(',') })
    return { invited: [...userIds], failed }
  } catch (err: any) {
    console.warn(`[Slack] batch invite failed (${err.message}); retrying per-user`)
  }

  // Fallback: invite each user on its own so one bad ID doesn't block the rest.
  for (const id of userIds) {
    try {
      await slackPost('conversations.invite', { channel: channelId, users: id })
      invited.push(id)
    } catch (err: any) {
      const msg = err.message || String(err)
      if (msg.includes('already_in_channel')) {
        invited.push(id)
      } else {
        failed.push({ id, error: msg })
      }
    }
  }
  return { invited, failed }
}

export async function createProjectSlackChannel(opts: {
  projectId: string
  projectName: string
  client: string
  /** Project ID (e.g. "2655") — prepended to channel slug to match the naming spine. */
  projectNumber?: string
  projectType?: string
  targetDelivery?: string
  /** Slack user ID(s) to auto-invite after creation (e.g., the requesting user) */
  inviteUserIds?: string[]
}): Promise<SlackChannelResult> {
  if (!process.env.SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN not configured — cannot create channel')
  }

  const { projectId, projectName, client, projectNumber, projectType, targetDelivery, inviteUserIds } = opts

  // Validate required fields up front so we don't ship a "client-undefined" channel.
  if (!projectName || !projectName.trim()) {
    throw new Error('createProjectSlackChannel: projectName is required')
  }
  if (!client || !client.trim()) {
    throw new Error('createProjectSlackChannel: client is required')
  }

  // Build channel name slug — {projectNumber}-{client}-{projectName}, matching
  // the {ID}_{Client}_{Project} spine. Skip the prefix if no number provided.
  const slugParts = [projectNumber, client, projectName].filter(
    (part) => part && String(part).trim(),
  )
  let slug = slugParts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)

  // Try to create the channel
  let channelId: string
  let channelName: string
  let reused = false
  try {
    const createData = await slackPost('conversations.create', {
      name: slug,
      is_private: false,
    })
    channelId = createData.channel.id
    channelName = createData.channel.name
  } catch (err: any) {
    // name_taken: either a prior attempt of THIS project already created the
    // channel (reconcile + reuse — no duplicate), or it's an unrelated channel
    // (append the project-id suffix and create a distinct one, as before).
    if (err.message?.includes('name_taken')) {
      const owned = await findOwnedChannelByName(slug, projectId)
      if (owned) {
        channelId = owned
        channelName = slug
        reused = true
      } else {
        const suffix = projectId.slice(0, 8)
        slug = `${slug.slice(0, 70)}-${suffix}`
        const createData = await slackPost('conversations.create', {
          name: slug,
          is_private: false,
        })
        channelId = createData.channel.id
        channelName = createData.channel.name
      }
    } else {
      throw err
    }
  }

  // Stamp the embedded Kit marker into the purpose so a later resume can
  // reconcile this channel by identity (idempotent — safe to re-set).
  if (!reused) {
    await slackPost('conversations.setPurpose', {
      channel: channelId,
      purpose: `${client} — ${projectName} ${kitChannelMarker(projectId)}`,
    }).catch(() => {}) // non-critical
  }

  // Set topic
  const topic = `${client} — ${projectName}`
  await slackPost('conversations.setTopic', {
    channel: channelId,
    topic,
  }).catch(() => {}) // non-critical

  // Invite the requesting user, PM, and team so they actually see the channel.
  // Resilient: one bad/deactivated user ID won't block the valid invites.
  if (inviteUserIds && inviteUserIds.length > 0) {
    const { failed } = await inviteUsersToChannel(channelId, inviteUserIds)
    if (failed.length > 0) {
      console.warn(
        `[Slack] ${failed.length} invite(s) skipped for ${channelId}: ` +
          failed.map((f) => `${f.id} (${f.error})`).join(', '),
      )
    }
  }

  // Post welcome message
  const lines = [
    `*Welcome to the ${projectName} project channel!*`,
    '',
    `*Client:* ${client}`,
  ]
  if (projectType) lines.push(`*Type:* ${projectType}`)
  if (targetDelivery) lines.push(`*Target delivery:* ${targetDelivery}`)
  lines.push(
    '',
    '_This channel was created automatically by Kit. All project updates, reviews, and discussions happen here._'
  )

  await slackPost('chat.postMessage', {
    channel: channelId,
    text: lines.join('\n'),
  }).catch(() => {}) // non-critical

  return {
    channelId,
    channelName,
    url: `https://slack.com/app_redirect?channel=${channelId}`,
  }
}

/**
 * Post a summary of all provisioned project links into the project's Slack channel.
 * Called after all external services have been provisioned.
 */
export async function postProjectLinks(opts: {
  channelId: string
  links: Record<string, string> // service name → URL
}): Promise<void> {
  if (!process.env.SLACK_BOT_TOKEN || !opts.channelId) return

  const entries = Object.entries(opts.links).filter(([, url]) => url)
  if (entries.length === 0) return

  const linkLines = entries.map(([service, url]) => `• *${service}:* <${url}|Open ${service}>`)
  const text = `:link: *Project links are ready:*\n${linkLines.join('\n')}`

  await slackPost('chat.postMessage', {
    channel: opts.channelId,
    text,
  }).catch((err: any) => {
    console.error('[Slack] Failed to post project links:', err.message)
  })
}

// ─── Project Channel Canvases (template duplication) ──────

export interface DuplicateCanvasesResult {
  /** IDs of canvases copied from the template and tabbed to the new channel */
  standaloneCanvasIds: string[]
  /** Per-clone mapping so callers can tell which new canvas came from which
   *  template (index-based alignment is unreliable — clones can be skipped). */
  clones: Array<{ templateFileId: string; canvasId: string; title: string }>
}

/**
 * List the template channel's canvases with their titles + normalized markdown
 * bodies. Used by Project Control template resolution (structural signature
 * match) so it and the cloner share one HTML→markdown path.
 */
export async function fetchTemplateCandidates(): Promise<{
  candidates: Array<{ fileId: string; title: string; markdown: string }>
  /**
   * True when enumeration was INCOMPLETE — the channel list failed, or any
   * candidate's body could not be fetched. The caller must treat resolution as
   * uncertain (fail closed: no generic clone), because a Project-Control-like
   * canvas could be among the ones we couldn't read.
   */
  partial: boolean
}> {
  const out: Array<{ fileId: string; title: string; markdown: string }> = []
  if (!process.env.SLACK_BOT_TOKEN) return { candidates: out, partial: true }
  let ids: string[]
  try {
    ids = await resolveCanvasTemplateFileIds()
  } catch (err) {
    console.warn('[Slack] fetchTemplateCandidates: channel enumeration failed:', (err as Error)?.message)
    return { candidates: out, partial: true }
  }
  let partial = false
  for (const fileId of ids) {
    try {
      const info = await slackGet('files.info', { file: fileId })
      const title: string = info.file?.title || info.file?.name || ''
      const url: string | undefined = info.file?.url_private_download || info.file?.url_private
      if (!url) { partial = true; continue }
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        signal: AbortSignal.timeout(SLACK_CALL_TIMEOUT_MS),
      })
      if (!res.ok) { partial = true; continue }
      const markdown = canvasHtmlToMarkdown(await res.text())
      out.push({ fileId, title, markdown })
    } catch (err) {
      partial = true
      console.warn(`[Slack] fetchTemplateCandidates(${fileId}) failed:`, (err as Error).message)
    }
  }
  return { candidates: out, partial }
}

/**
 * Fetch a canvas file's markdown content via the file's download URL.
 * Slack canvases are served as markdown text behind url_private_download.
 */
async function fetchCanvasMarkdown(fileId: string): Promise<string | null> {
  try {
    const info = await slackGet('files.info', { file: fileId })
    const url: string | undefined =
      info.file?.url_private_download || info.file?.url_private
    if (!url) {
      console.warn(`[Slack] canvas file ${fileId}: no download url`)
      return null
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    })
    if (!res.ok) {
      console.warn(`[Slack] canvas file ${fileId}: download ${res.status}`)
      return null
    }
    return await res.text()
  } catch (err: any) {
    console.warn(`[Slack] fetchCanvasMarkdown(${fileId}) failed:`, err.message)
    return null
  }
}

// Slack template channel — Kit reads all canvases tabbed to this channel
// at provision time and clones each one into the new project channel.
// Override at runtime via SLACK_TEMPLATE_CHANNEL_ID. The bot must be a
// member of this channel so files.info can see download URLs.
const DEFAULT_TEMPLATE_CHANNEL_ID = 'C0B1312H89L'

// Hardcoded fallback if files.list returns nothing (e.g. permission issue).
// Kept narrow so the dynamic lister is the source of truth in production.
const FALLBACK_CANVAS_TEMPLATE_FILE_IDS: string[] = []

/**
 * Resolve which canvas file IDs to clone for new project channels.
 *
 * Precedence:
 *   1. SLACK_CANVAS_TEMPLATE_FILE_IDS env var (explicit override, comma-sep)
 *   2. files.list on the template channel, filtered to canvases — dynamic,
 *      so editors can add/remove canvases in C0B1312H89L without redeploys
 *   3. FALLBACK_CANVAS_TEMPLATE_FILE_IDS hardcoded list
 */
async function resolveCanvasTemplateFileIds(): Promise<string[]> {
  const envOverride = process.env.SLACK_CANVAS_TEMPLATE_FILE_IDS
  if (envOverride) {
    const ids = envOverride.split(',').map((s) => s.trim()).filter(Boolean)
    console.log(`[Slack canvas] template resolution: env override (${ids.length} ids)`)
    return ids
  }

  const channelId =
    process.env.SLACK_TEMPLATE_CHANNEL_ID || DEFAULT_TEMPLATE_CHANNEL_ID
  try {
    const res = await slackGet('files.list', {
      channel: channelId,
      types: 'canvases',
      count: '50',
    })
    const files: any[] = res.files || []
    if (files.length > 0) {
      // Sort by created ascending so the order of canvases in the new
      // project mirrors the order they were added to the template channel.
      files.sort((a, b) => (a.created || 0) - (b.created || 0))
      const ids = files.map((f) => f.id).filter(Boolean)
      console.log(
        `[Slack canvas] template resolution: ${ids.length} canvas(es) found in ${channelId}: ${files
          .map((f) => `${f.id}(${f.title || f.name})`)
          .join(', ')}`,
      )
      return ids
    }
    console.warn(
      `[Slack canvas] template resolution: files.list found no canvases in ${channelId}; using fallback`,
    )
  } catch (err: any) {
    console.warn(
      `[Slack canvas] template resolution: files.list(${channelId}) failed: ${err.message}; using fallback`,
    )
  }

  return FALLBACK_CANVAS_TEMPLATE_FILE_IDS
}

/**
 * Clone each canvas template into a new standalone canvas titled after the
 * project, share it to the channel with write access, and pin it as a
 * bookmark so it shows up as a tab at the top of the channel.
 *
 * Content is copied verbatim from the templates — producers customize per
 * project after creation.
 */
export async function duplicateTemplateCanvases(opts: {
  newChannelId: string
  projectName: string
  projectNumber?: string
  client?: string
  /** Known project metadata — filled into the template's top metadata table. */
  projectType?: string
  producerSlackId?: string
  cdSlackId?: string
  delivery?: string
  /** Asset-folder links Kit just created — filled into the Assets Folders table. */
  dropboxUrl?: string
  frameioUrl?: string
  /** Template file ids to skip in generic cloning (e.g. the Project Control
   *  template, which is created/managed through its own dedicated path). */
  excludeFileIds?: string[]
}): Promise<DuplicateCanvasesResult> {
  const out: DuplicateCanvasesResult = { standaloneCanvasIds: [], clones: [] }
  if (!process.env.SLACK_BOT_TOKEN) {
    console.warn('[Slack canvas] SLACK_BOT_TOKEN missing; skipping')
    return out
  }

  // Dynamic template resolution: list every canvas tabbed to the template
  // channel and clone all of them. Editors maintain the templates by
  // adding/removing canvases in C0B1312H89L — no env-var changes needed.
  const excluded = new Set(opts.excludeFileIds || [])
  const templateFileIds = (await resolveCanvasTemplateFileIds()).filter((id) => !excluded.has(id))
  if (templateFileIds.length === 0) {
    console.warn('[Slack canvas] no template canvases resolved; skipping')
    return out
  }

  console.log(`[Slack canvas] duplicating ${templateFileIds.length} template(s) for channel ${opts.newChannelId}: ${templateFileIds.join(', ')}`)

  // Build the project spine prefix used in every new canvas title:
  //   {projectNumber}_{client}_{projectName} — matches Frame.io / Dropbox / Harvest.
  // Fall back gracefully if any part is missing.
  const spineParts = [opts.projectNumber, opts.client, opts.projectName]
    .map((p) => (p ? String(p).trim() : ''))
    .filter(Boolean)
  const spine = spineParts.join('_') || opts.projectName

  // Clean a template canvas title for use in the new canvas name:
  //  - strip :emoji_shortcode: patterns (don't render in canvas titles)
  //  - strip the "2xxx" placeholder Slack templates use for project IDs
  //  - strip the word "Template"
  //  - collapse whitespace
  const cleanTemplateTitle = (raw: string, fallback: string): string => {
    const cleaned = raw
      .replace(/:[a-z0-9_+-]+:/gi, '') // :clapper:, :memo:, etc.
      .replace(/\b2x{2,}\b/gi, '') // 2xxx, 2xxxx — template project-ID placeholder
      .replace(/\btemplate\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
    return cleaned || fallback
  }

  for (const [idx, fileId] of templateFileIds.entries()) {
    try {
      // 1. Read the template's title + markdown via files.info (requires the
      //    bot to be a collaborator on the canvas).
      let originalTitle = `Canvas ${idx + 1}`
      let downloadUrl: string | undefined
      try {
        const info = await slackGet('files.info', { file: fileId })
        const raw: string = info.file?.title || info.file?.name || originalTitle
        originalTitle = cleanTemplateTitle(raw, originalTitle)
        downloadUrl = info.file?.url_private_download || info.file?.url_private
      } catch (err: any) {
        console.error(`[Slack canvas] ${fileId}: files.info failed — bot may need to be added as a collaborator: ${err.message}`)
        continue
      }

      if (!downloadUrl) {
        console.error(`[Slack canvas] ${fileId}: no download URL on file info`)
        continue
      }

      // 2. Fetch the canvas body. Slack returns it as Quip-flavored HTML,
      //    not markdown, so we convert before posting to canvases.create.
      let markdown: string
      try {
        const res = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        })
        if (!res.ok) {
          console.error(`[Slack canvas] ${fileId}: download HTTP ${res.status}`)
          continue
        }
        const html = await res.text()
        markdown = canvasHtmlToMarkdown(html)
      } catch (err: any) {
        console.error(`[Slack canvas] ${fileId}: fetch/convert threw: ${err.message}`)
        continue
      }

      // Auto-fill the template's project-metadata table with everything we
      // know at provisioning time (Client, Project Type, Producer, CD,
      // Delivery) + the placeholder H1. Non-destructive: only empty cells
      // get filled, and only the first match per field. Producers still
      // fill the rest (contacts, VO, music, specs) by hand.
      markdown = fillCanvasTemplate(markdown, {
        client: opts.client,
        projectType: opts.projectType,
        producer: opts.producerSlackId ? `<@${opts.producerSlackId}>` : undefined,
        cd: opts.cdSlackId ? `<@${opts.cdSlackId}>` : undefined,
        delivery: opts.delivery,
        dropbox: opts.dropboxUrl,
        frameio: opts.frameioUrl,
        headerTitle: spine,
      })

      // 3. Create the new canvas, tabbed directly to the channel.
      //    Per Slack's canvases.create reference, `channel_id` is the
      //    "Channel ID for tabbing the canvas" — this is what the
      //    "+ Share a canvas" UI calls internally. Doing it as part of
      //    create (rather than canvases.access.set after the fact) is
      //    what makes the canvas appear in the channel header as a tab.
      const newTitle = `${spine} — ${originalTitle}`
      let canvasId: string | undefined
      try {
        const created = await slackPost('canvases.create', {
          title: newTitle,
          channel_id: opts.newChannelId,
          document_content: { type: 'markdown', markdown },
        })
        canvasId = created.canvas_id
        console.log(`[Slack canvas] ${fileId}: created canvas ${canvasId} tabbed to ${opts.newChannelId} as "${newTitle}"`)
      } catch (err: any) {
        console.error(`[Slack canvas] ${fileId}: canvases.create failed: ${err.message}`)
        // Log the first chunk of the rejected markdown so we can see what
        // Slack didn't like. Most likely culprits: workspace-custom emoji
        // shortcodes (:microsoft-word:), heading-looking text in cells
        // (####), or a too-large/malformed GFM table.
        console.error(
          `[Slack canvas] ${fileId}: rejected markdown (first 1500 chars):\n${markdown.slice(0, 1500)}`,
        )
        // Fallback: create the canvas empty but still tabbed to the channel.
        // Better to have a placeholder chip than nothing at all.
        try {
          const fallback = await slackPost('canvases.create', {
            title: newTitle,
            channel_id: opts.newChannelId,
          })
          canvasId = fallback.canvas_id
          console.log(`[Slack canvas] ${fileId}: fallback empty canvas ${canvasId} tabbed to ${opts.newChannelId}`)
        } catch (fallbackErr: any) {
          console.error(`[Slack canvas] ${fileId}: empty fallback also failed: ${fallbackErr.message}`)
          continue
        }
      }

      if (!canvasId) {
        console.error(`[Slack canvas] ${fileId}: canvases.create returned no canvas_id`)
        continue
      }
      out.standaloneCanvasIds.push(canvasId)
      out.clones.push({ templateFileId: fileId, canvasId, title: newTitle })

      // 4. Also grant the channel write access so members can edit, not
      //    just read. The channel_id on create gives read; this upgrades it.
      try {
        await slackPost('canvases.access.set', {
          canvas_id: canvasId,
          access_level: 'write',
          channel_ids: [opts.newChannelId],
        })
        console.log(`[Slack canvas] ${canvasId}: granted write access to ${opts.newChannelId}`)
      } catch (err: any) {
        console.warn(`[Slack canvas] ${canvasId}: access.set failed: ${err.message}`)
      }
    } catch (err: any) {
      console.error(`[Slack canvas] ${fileId}: unexpected failure: ${err.message}`)
    }
  }

  console.log(`[Slack canvas] done — ${out.standaloneCanvasIds.length} canvas(es) created for ${opts.newChannelId}`)
  return out
}

