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
}): Promise<DuplicateCanvasesResult> {
  const out: DuplicateCanvasesResult = { channelCanvasId: null, standaloneCanvasIds: [] }
  if (!process.env.SLACK_BOT_TOKEN) return out

  const fileIdsEnv = process.env.SLACK_CANVAS_TEMPLATE_FILE_IDS
  const templateFileIds = fileIdsEnv
    ? fileIdsEnv.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CANVAS_TEMPLATE_FILE_IDS

  for (const fileId of templateFileIds) {
    try {
      // Pull the template title so the new canvas keeps its descriptor
      // (e.g. "Project Brief"), but strip the word "Template" so the
      // duplicate doesn't read "Project Brief Template — <project>".
      let originalTitle = `${opts.projectName} canvas`
      try {
        const info = await slackGet('files.info', { file: fileId })
        const raw: string = info.file?.title || info.file?.name || originalTitle
        originalTitle = raw.replace(/\btemplate\b/gi, '').replace(/\s+/g, ' ').trim() || originalTitle
      } catch (err: any) {
        console.warn(`[Slack] canvas template ${fileId}: files.info failed:`, err.message)
      }

      const markdown = await fetchCanvasMarkdown(fileId)
      if (!markdown) {
        console.warn(`[Slack] canvas template ${fileId}: no markdown; skipping`)
        continue
      }

      const newTitle = `${opts.projectName} — ${originalTitle}`
      const created = await slackPost('canvases.create', {
        title: newTitle,
        document_content: { type: 'markdown', markdown },
      })
      const canvasId: string | undefined = created.canvas_id
      if (!canvasId) {
        console.warn(`[Slack] canvas template ${fileId}: create returned no canvas_id`)
        continue
      }
      out.standaloneCanvasIds.push(canvasId)

      // Give the new channel write access so members can edit
      await slackPost('canvases.access.set', {
        canvas_id: canvasId,
        access_level: 'write',
        channel_ids: [opts.newChannelId],
      }).catch((err: any) =>
        console.warn('[Slack] canvas access.set failed:', err.message),
      )

      // Pin as a bookmark so it shows as a tab at the top of the channel
      await slackPost('bookmarks.add', {
        channel_id: opts.newChannelId,
        title: newTitle,
        type: 'link',
        link: `https://slack.com/docs/${canvasId}`,
        emoji: ':notebook_with_decorative_cover:',
      }).catch((err: any) =>
        console.warn('[Slack] bookmarks.add failed:', err.message),
      )
    } catch (err: any) {
      console.error(`[Slack] canvas template ${fileId} duplication failed:`, err.message)
    }
  }

  return out
}

