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

/**
 * Duplicate the canvases attached to SLACK_TEMPLATE_CHANNEL_ID into a freshly
 * created project channel:
 *   1. The template channel's channel-canvas (header-pinned) becomes the new
 *      channel's channel-canvas.
 *   2. Any standalone canvas files shared in the template channel are recreated
 *      as new standalone canvases and shared to the project channel.
 *
 * Content is copied verbatim — producers customize per-project after creation.
 */
export async function duplicateTemplateCanvases(opts: {
  newChannelId: string
  projectName: string
}): Promise<DuplicateCanvasesResult> {
  const out: DuplicateCanvasesResult = { channelCanvasId: null, standaloneCanvasIds: [] }
  const templateId = process.env.SLACK_TEMPLATE_CHANNEL_ID
  if (!process.env.SLACK_BOT_TOKEN || !templateId) {
    if (!templateId) console.warn('[Slack] SLACK_TEMPLATE_CHANNEL_ID not set; skipping canvas copy')
    return out
  }

  // 1. Look up the template channel to find its channel canvas
  let templateChannelCanvasFileId: string | undefined
  try {
    const info = await slackGet('conversations.info', { channel: templateId })
    templateChannelCanvasFileId = info.channel?.properties?.canvas?.file_id
  } catch (err: any) {
    console.warn('[Slack] template channel info failed:', err.message)
  }

  // 2. Recreate the channel canvas on the new channel
  if (templateChannelCanvasFileId) {
    const markdown = await fetchCanvasMarkdown(templateChannelCanvasFileId)
    if (markdown) {
      try {
        const created = await slackPost('conversations.canvases.create', {
          channel_id: opts.newChannelId,
          document_content: { type: 'markdown', markdown },
        })
        out.channelCanvasId = created.canvas_id || null
      } catch (err: any) {
        console.error('[Slack] channel canvas create failed:', err.message)
      }
    }
  }

  // 3. Find standalone canvases shared in the template channel and recreate them
  try {
    const filesRes = await slackPost('files.list', {
      channel: templateId,
      types: 'canvases',
      count: 50,
    })
    const files: any[] = filesRes.files || []
    for (const file of files) {
      // Skip the channel canvas itself — it's already handled above
      if (file.id === templateChannelCanvasFileId) continue

      const markdown = await fetchCanvasMarkdown(file.id)
      if (!markdown) continue

      try {
        const created = await slackPost('canvases.create', {
          title: file.title || file.name || `${opts.projectName} canvas`,
          document_content: { type: 'markdown', markdown },
        })
        const canvasId: string | undefined = created.canvas_id
        if (!canvasId) continue
        out.standaloneCanvasIds.push(canvasId)

        await slackPost('canvases.access.set', {
          canvas_id: canvasId,
          access_level: 'write',
          channel_ids: [opts.newChannelId],
        }).catch((err: any) =>
          console.warn('[Slack] canvas access.set failed:', err.message),
        )

        await slackPost('chat.postMessage', {
          channel: opts.newChannelId,
          text: `:notebook_with_decorative_cover: <https://slack.com/docs/${canvasId}|${file.title || 'Project canvas'}>`,
        }).catch(() => {})
      } catch (err: any) {
        console.error('[Slack] standalone canvas create failed:', err.message)
      }
    }
  } catch (err: any) {
    console.warn('[Slack] files.list (template canvases) failed:', err.message)
  }

  return out
}

