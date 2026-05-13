// @ts-nocheck
/**
 * Lightweight Slack channel creation for MCP tool use.
 * Reuses the same Slack API pattern as the provisioner but takes
 * simple project fields instead of a full ProjectIntakeForm.
 */

import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import * as nodeEmoji from 'node-emoji'

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

// Slack canvas markdown is stricter than CommonMark/GFM. Things that
// turndown emits by default but trip canvases.create with
// canvas_creation_failed include:
//   - escaped brackets: \[Foo\] (turndown does this to protect link
//     syntax). Slack treats the backslash as literal.
//   - workspace-custom emoji shortcodes like :microsoft-word:, :figma:.
//     Standard Unicode-mapped shortcodes (:smile:) are fine; custom ones
//     are not resolved.
//   - heading markers (####) appearing inside table cells.
// Slack emoji shortcodes that node-emoji@^2 doesn't recognize (its
// emojilib-based dataset uses different primary names for these). Applied
// before nodeEmoji.emojify so the leftover-shortcode stripper doesn't eat
// them. Extend this map as we hit more.
const SLACK_EMOJI_OVERRIDES: Record<string, string> = {
  telephone_receiver: '📞',
  speech_balloon: '💬',
  envelope: '✉️',
  email: '✉️',
  e_mail: '📧',
  memo: '📝',
  clapper: '🎬',
  movie_camera: '🎥',
  film_projector: '📽️',
  film_strip: '🎞️',
  page_facing_up: '📄',
  bookmark_tabs: '📑',
  open_file_folder: '📂',
  file_folder: '📁',
  pencil2: '✏️',
}

function sanitizeCanvasMarkdown(md: string): string {
  let s = md
  // Unescape brackets — Slack canvas treats \[ as a literal backslash
  // followed by a bracket, not as an escaped bracket.
  s = s.replace(/\\\[/g, '[').replace(/\\\]/g, ']')
  // Unescape underscores. Turndown escapes them so plain text like
  // "telephone_receiver" doesn't get italicized as "telephone<em>receiver</em>".
  // But for emoji shortcodes (:telephone_receiver:) the escape is what makes
  // the emojify regex below fail to match — so the shortcode passes through
  // and renders as literal text in the canvas. Canvas treats `_` as italic
  // start/end only when paired, so a bare underscore in shortcodes is safe.
  s = s.replace(/\\_/g, '_')
  // First pass: apply our overrides for Slack shortcodes node-emoji misses.
  s = s.replace(/:([a-z0-9_+-]+):/gi, (m, name) => {
    const key = String(name).toLowerCase()
    return SLACK_EMOJI_OVERRIDES[key] ?? m
  })
  // Second pass: emojify everything else node-emoji does know.
  s = nodeEmoji.emojify(s)
  // Strip any leftover :shortcode: patterns — those are workspace-custom
  // emoji that node-emoji didn't recognize, which canvas can't resolve and
  // which sometimes trigger canvas_creation_failed.
  s = s.replace(/:[a-z0-9_+-]+:/gi, '')
  // Collapse any double whitespace left where emoji used to sit.
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

function headers() {
  return {
    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    'Content-Type': 'application/json; charset=utf-8',
  }
}

async function slackPost(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
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
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`)
  return data
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
  try {
    const createData = await slackPost('conversations.create', {
      name: slug,
      is_private: false,
    })
    channelId = createData.channel.id
    channelName = createData.channel.name
  } catch (err: any) {
    // If name is taken, append short project ID suffix and retry
    if (err.message?.includes('name_taken')) {
      const suffix = projectId.slice(0, 8)
      slug = `${slug.slice(0, 70)}-${suffix}`
      const createData = await slackPost('conversations.create', {
        name: slug,
        is_private: false,
      })
      channelId = createData.channel.id
      channelName = createData.channel.name
    } else {
      throw err
    }
  }

  // Set topic
  const topic = `${client} — ${projectName}`
  await slackPost('conversations.setTopic', {
    channel: channelId,
    topic,
  }).catch(() => {}) // non-critical

  // Invite the requesting user so they actually see the channel
  if (inviteUserIds && inviteUserIds.length > 0) {
    await slackPost('conversations.invite', {
      channel: channelId,
      users: inviteUserIds.join(','),
    }).catch((err: any) => {
      console.warn('[Slack] conversations.invite failed (non-fatal):', err.message)
    })
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
  /** ID of the new channel canvas attached to the project channel header */
  channelCanvasId: string | null
  /** IDs of standalone canvases copied from the template and shared to the channel */
  standaloneCanvasIds: string[]
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
}): Promise<DuplicateCanvasesResult> {
  const out: DuplicateCanvasesResult = { channelCanvasId: null, standaloneCanvasIds: [] }
  if (!process.env.SLACK_BOT_TOKEN) {
    console.warn('[Slack canvas] SLACK_BOT_TOKEN missing; skipping')
    return out
  }

  // Dynamic template resolution: list every canvas tabbed to the template
  // channel and clone all of them. Editors maintain the templates by
  // adding/removing canvases in C0B1312H89L — no env-var changes needed.
  const templateFileIds = await resolveCanvasTemplateFileIds()
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
        console.log(`[Slack canvas] ${fileId}: title="${originalTitle}", has_download=${!!downloadUrl}`)
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
        // Dump raw HTML so we can diagnose conversion problems on richer
        // canvases (toggles, columns, multi-row tables). Chunk it because
        // Railway truncates very long log lines.
        const HTML_CHUNK = 4000
        for (let off = 0; off < html.length; off += HTML_CHUNK) {
          console.log(
            `[Slack canvas] ${fileId}: RAW_HTML[${off}..${Math.min(off + HTML_CHUNK, html.length)}]\n${html.slice(off, off + HTML_CHUNK)}`,
          )
        }
        markdown = canvasHtmlToMarkdown(html)
        console.log(`[Slack canvas] ${fileId}: html=${html.length} chars → markdown=${markdown.length} chars`)
      } catch (err: any) {
        console.error(`[Slack canvas] ${fileId}: fetch/convert threw: ${err.message}`)
        continue
      }

      // 3. Create the new canvas, tabbed directly to the channel.
      //    Per Slack's canvases.create reference, `channel_id` is the
      //    "Channel ID for tabbing the canvas" — this is what the
      //    "+ Share a canvas" UI calls internally. Doing it as part of
      //    create (rather than canvases.access.set after the fact) is
      //    what makes the canvas appear in the channel header as a tab.
      const newTitle = `${spine} — ${originalTitle}`
      // Debug: emit the first 800 chars of the markdown so we can see what
      // actually ships to Slack — useful when emoji shortcodes or other
      // template tokens come through as literal text.
      console.log(
        `[Slack canvas] ${fileId}: markdown preview (first 800 chars):\n${markdown.slice(0, 800)}`,
      )
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

