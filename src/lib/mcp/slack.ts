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
  projectType?: string
  targetDelivery?: string
  /** Slack user ID(s) to auto-invite after creation (e.g., the requesting user) */
  inviteUserIds?: string[]
}): Promise<SlackChannelResult> {
  if (!process.env.SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN not configured — cannot create channel')
  }

  const { projectId, projectName, client, projectType, targetDelivery, inviteUserIds } = opts

  // Validate required fields up front so we don't ship a "client-undefined" channel.
  if (!projectName || !projectName.trim()) {
    throw new Error('createProjectSlackChannel: projectName is required')
  }
  if (!client || !client.trim()) {
    throw new Error('createProjectSlackChannel: client is required')
  }

  // Build channel name slug
  let slug = `${client}-${projectName}`
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

// ─── Project Channel Canvas ────────────────────────────────

export interface ProjectCanvasData {
  channelId: string
  projectName: string
  projectCode?: string
  client: string
  projectType?: string
  targetDelivery?: string
  startDate?: string
  briefSummary?: string
  links?: {
    dropbox?: string
    frameio?: string
    harvest?: string
    figma?: string
  }
}

/**
 * Create a channel canvas from the Project Channel Template,
 * pre-filled with real project data and provisioned links.
 */
export async function createProjectCanvas(data: ProjectCanvasData): Promise<string | null> {
  if (!process.env.SLACK_BOT_TOKEN) return null

  const {
    channelId,
    projectName,
    projectCode,
    client,
    projectType,
    targetDelivery,
    startDate,
    briefSummary,
    links,
  } = data

  const deliveryDate = targetDelivery || 'TBD'
  const phase = 'Discovery'
  const today = new Date().toISOString().split('T')[0]

  // Build the Links table rows with real provisioned URLs
  const linkRows: string[] = []
  linkRows.push('|**:microsoft-word: Script**|[paste link]|')
  linkRows.push('|**:figma: Figma — Client**|[paste link]|')
  if (links?.figma) {
    linkRows.push(`|**:figma: Figma — R&F**|[${links.figma}](${links.figma})|`)
  } else {
    linkRows.push('|**:figma: Figma — R&F**|[paste link]|')
  }
  if (links?.dropbox) {
    linkRows.push(`|**:dropbox: Assets Folder**|[Dropbox](${links.dropbox})|`)
  } else {
    linkRows.push('|**:dropbox: Assets Folder**|[paste link]|')
  }
  if (links?.frameio) {
    linkRows.push(`|**:frame_with_picture: Frame.io**|[Frame.io](${links.frameio})|`)
  }
  if (links?.harvest) {
    linkRows.push(`|**:timer_clock: Harvest**|[Harvest](${links.harvest})|`)
  }
  linkRows.push('|**:page_with_curl: Brief**|[paste link]|')

  const markdown = `# 🎬 ${projectName}

---

## 📌 Project Snapshot

|Field|Value|
|  ---  |  ---  |
|**Project Name**|${projectName}|
|**Project Code**|${projectCode || '[TBD]'}|
|**Client**|${client}|
|**Project Manager**|[@PM]|
|**Creative Director**|[@CD]|
|**Lead Editor / Animator**|[@Lead]|
|**Due Date**|${deliveryDate}|
|**Status**|🟢 On Track|
|**Current Phase**|${phase}|

---

## 📅 This Week

|Field|Value|
|  ---  |  ---  |
|**This Week's Goal**|[What we're trying to land this week]|
|**What's Due Next**|[Specific deliverable + owner]|
|**Next Milestone**|[Date — milestone name]|

### Top 3 priorities

* [ ] [Priority 1]
* [ ] [Priority 2]
* [ ] [Priority 3]

### Open blockers

* [ ] [Blocker / decision needed / waiting on client]

---

## 🎯 Milestones

|Milestone|Date|Link|
|  ---  |  ---  |  ---  |
|Kickoff call|![](slack_date:${startDate || today}) |—|
|Discovery|![](slack_date:${today}) |—|
|Script v1|![](slack_date:${today}) |—|
|Style frames|![](slack_date:${today}) |—|
|Design v1|![](slack_date:${today}) |—|
|Boardomatic v1|![](slack_date:${today}) |—|
|Boardomatic v2|![](slack_date:${today}) |—|
|Animation v1|![](slack_date:${today}) |—|
|Animation v2|![](slack_date:${today}) |—|
|Final review|![](slack_date:${today}) |—|
|Delivery|![](slack_date:${deliveryDate !== 'TBD' ? deliveryDate : today}) |—|

---

## 🔗 Links

|Resource|Link|
|  ---  |  ---  |
${linkRows.join('\n')}

---

## 🗒️ Notes & Feedback

:email: **_Email note from client | ${new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' })}_**

[paste notes here]

---

## 👥 Team & Channels

* **Internal channel:** this channel
* **Client channel:** [#client-channel]${links?.frameio ? `\n* **Frame.io project:** [${links.frameio}](${links.frameio})` : '\n* **Frame.io project:** [paste link]'}
* **Project Manager:** [@PM]
* **Creative Director:** [@CD]
* **Producer:** [@Producer]
* **Lead Artist:** [@Lead]

---`

  try {
    const result = await slackPost('canvases.create', {
      title: projectName,
      document_content: {
        type: 'markdown',
        markdown,
      },
    })

    const canvasId = result.canvas_id

    // Share the canvas to the project channel
    if (canvasId) {
      await slackPost('canvases.access.set', {
        canvas_id: canvasId,
        access_level: 'write',
        channel_ids: [channelId],
      }).catch((err: any) => {
        console.warn('[Slack] Could not share canvas to channel:', err.message)
      })

      // Post the canvas link in the channel
      await slackPost('chat.postMessage', {
        channel: channelId,
        text: `:notebook_with_decorative_cover: *Project canvas is ready:* <https://slack.com/docs/${canvasId}|Open Canvas>`,
      }).catch(() => {})
    }

    console.log(`[Slack] Created project canvas: ${canvasId}`)
    return canvasId
  } catch (err: any) {
    console.error('[Slack] Canvas creation failed:', err.message)
    return null
  }
}
