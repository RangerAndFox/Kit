// @ts-nocheck
/**
 * Lightweight Slack channel creation for MCP tool use.
 * Reuses the same Slack API pattern as the provisioner but takes
 * simple project fields instead of a full ProjectIntakeForm.
 */

const SLACK_API = 'https://slack.com/api'

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

// Two production canvas templates that get cloned into every new project
// channel and pinned as bookmark tabs. Override at runtime via
// SLACK_CANVAS_TEMPLATE_FILE_IDS (comma-separated list of file IDs).
const DEFAULT_CANVAS_TEMPLATE_FILE_IDS = ['F0B1GTVJV5F', 'F0B1GUWHYTB']

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

  const fileIdsEnv = process.env.SLACK_CANVAS_TEMPLATE_FILE_IDS
  const templateFileIds = fileIdsEnv
    ? fileIdsEnv.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CANVAS_TEMPLATE_FILE_IDS

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

      // 2. Fetch the markdown body
      let markdown: string
      try {
        const res = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        })
        if (!res.ok) {
          console.error(`[Slack canvas] ${fileId}: markdown download HTTP ${res.status}`)
          continue
        }
        markdown = await res.text()
        console.log(`[Slack canvas] ${fileId}: markdown fetched (${markdown.length} chars)`)
      } catch (err: any) {
        console.error(`[Slack canvas] ${fileId}: markdown fetch threw: ${err.message}`)
        continue
      }

      // 3. Create the new canvas with the duplicated content
      const newTitle = `${spine} — ${originalTitle}`
      let canvasId: string | undefined
      try {
        const created = await slackPost('canvases.create', {
          title: newTitle,
          document_content: { type: 'markdown', markdown },
        })
        canvasId = created.canvas_id
        console.log(`[Slack canvas] ${fileId}: created new canvas ${canvasId} titled "${newTitle}"`)
      } catch (err: any) {
        console.error(`[Slack canvas] ${fileId}: canvases.create failed: ${err.message}`)
        continue
      }

      if (!canvasId) {
        console.error(`[Slack canvas] ${fileId}: canvases.create returned no canvas_id`)
        continue
      }
      out.standaloneCanvasIds.push(canvasId)

      // 4. Post the canvas link in the channel. Slack's canvases.access.set
      //    docs explicitly require the canvas link to be shared in the channel
      //    first — that's what registers the canvas as a channel canvas chip
      //    (instead of an invisibly-shared standalone canvas). This is the
      //    same surface as clicking "+" → "Share a canvas" in the UI.
      try {
        await slackPost('chat.postMessage', {
          channel: opts.newChannelId,
          text: `<https://slack.com/docs/${canvasId}|${newTitle}>`,
          unfurl_links: true,
        })
        console.log(`[Slack canvas] ${canvasId}: posted link in ${opts.newChannelId}`)
      } catch (err: any) {
        console.warn(`[Slack canvas] ${canvasId}: link post failed: ${err.message}`)
      }

      // 5. Now grant the channel write access so members can edit.
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

