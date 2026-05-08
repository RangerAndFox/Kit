// @ts-nocheck
/**
 * Lightweight Slack channel creation for MCP tool use.
 * Reuses the same Slack API pattern as the provisioner but takes
 * simple project fields instead of a full ProjectIntakeForm.
 */

import { isProjectId, parseProjectId, projectChannelName } from '@/lib/provisioner/naming'

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
  /** The spine project ID, when available — drives the `proj-` channel naming. */
  projectCode?: string
  projectType?: string
  targetDelivery?: string
  /** Slack user ID(s) to auto-invite after creation (e.g., the requesting user) */
  inviteUserIds?: string[]
}): Promise<SlackChannelResult> {
  if (!process.env.SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN not configured — cannot create channel')
  }

  const { projectId, projectName, client, projectCode, projectType, targetDelivery, inviteUserIds } = opts

  // Validate required fields up front so we don't ship a "client-undefined" channel.
  if (!projectName || !projectName.trim()) {
    throw new Error('createProjectSlackChannel: projectName is required')
  }
  if (!client || !client.trim()) {
    throw new Error('createProjectSlackChannel: client is required')
  }

  // Build channel name slug. Per §4 of the blueprint, project channels use
  // the `proj-` prefix when we have a spine-formatted project ID. NL-driven
  // provisioning calls (without a spine ID) fall back to the legacy
  // `{client}-{projectName}` slug.
  let slug = isProjectId(projectCode)
    ? projectChannelName(projectCode!)
    : `${client}-${projectName}`
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

// ─── Project Channel Canvases ──────────────────────────────
//
// Per the Ranger & Fox Operations Blueprint §5, every project gets TWO
// canvases pinned to its Slack channel:
//
//   1. Source of Truth (SoT) — the structured project record. Sections
//      are fixed (§5): Identification, Scope, Budget, Schedule, Status,
//      Links, Team, Delivery Spec. Kit edits this only after producer
//      ✅ confirmation; it's the contract.
//
//   2. Running Notes — append-only log of decisions, action items,
//      feedback round summaries, meeting notes, and blockers. Kit
//      writes here automatically (Tier 2 / act + notify).
//
// Titles use the spine format from §3: `[id] :: SOT` and `[id] :: NOTES`.
// Today the project ID is whatever `projectCode` is set to; once the
// naming-spine refactor lands the IDs will conform to
// `[CLIENT]-[PROJECT#]-[SHORTNAME]` automatically without re-templating.

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

export interface ProjectCanvasIds {
  sotCanvasId: string | null
  notesCanvasId: string | null
}

function buildSourceOfTruthMarkdown(data: ProjectCanvasData): string {
  const { projectName, projectCode, client, targetDelivery, startDate, links } = data
  const today = new Date().toISOString().split('T')[0]
  const kickoff = startDate || today
  const delivery = targetDelivery || 'TBD'
  const projectId = projectCode || projectName

  // Pull the descriptive piece out of the spine ID for the Shortname cell;
  // for legacy non-spine codes, fall back to the raw projectCode.
  const parsed = parseProjectId(projectId)
  const shortname = parsed ? parsed.shortname : (projectCode || '—')

  const linkRow = (label: string, url?: string) =>
    url
      ? `|**${label}**|[${url}](${url})|`
      : `|**${label}**|[paste link]|`

  return `# ${projectId} :: Source of Truth

> The single answer to "where are we on this?" — fixed-template per §5 of the R&F Operations Blueprint. Maintained by Kit; producer-confirmed.

---

## 1. Project Identification

|Field|Value|
|---|---|
|**Project ID**|${projectId}|
|**Client**|${client}|
|**Shortname**|${shortname}|
|**Internal lead (Producer)**|[@PM]|
|**Client contacts**|[name, role, email]|
|**Kickoff date**|${kickoff}|
|**Target delivery**|${delivery}|
|**Final delivery**|—|

---

## 2. Scope of Record

### Deliverables

* [Format · length · language · accessibility tier]

### Out of Scope

* —

### Change Orders

|Date|Scope delta|Signed-off by|
|---|---|---|
|—|—|—|

---

## 3. Budget

|Field|Value|
|---|---|
|**Total budget**|$—|
|**Concept / Strategy**|$—|
|**Design / Boards**|$—|
|**Animation**|$—|
|**Finishing / Color / Sound**|$—|
|**Delivery / Accessibility**|$—|
|**Burn %**|0% _(auto-updated daily by Kit from Harvest)_|
|**Projected EAC**|— _(at current velocity)_|

---

## 4. Schedule

|Milestone|Date|Status|
|---|---|---|
|Kickoff|${kickoff}|—|
|Concept|—|—|
|Design / Boards|—|—|
|Animation v1|—|—|
|Final review|—|—|
|Delivery|${delivery}|—|

**Critical path:** —

---

## 5. Status

|Field|Value|
|---|---|
|**Phase**|Concept|
|**Stoplight**|🟢 Green|
|**Last updated**|${today} _(auto)_|

---

## 6. Links

|Resource|Link|
|---|---|
${linkRow(':dropbox: Dropbox folder', links?.dropbox)}
${linkRow(':frame_with_picture: Frame.io project', links?.frameio)}
${linkRow(':timer_clock: Harvest project', links?.harvest)}
${linkRow(':page_with_curl: Brief / SOW PDF')}

---

## 7. Team

|Role|Person|
|---|---|
|Producer|[@PM]|
|Senior Animator|[@Lead]|
|Animators|—|
|Editor|—|
|Sound|—|
|QC|—|

---

## 8. Delivery Spec

_Default: Microsoft standard. Edit if the client spec differs._

* MP4 master · H.264 · 1920×1080 or 3840×2160 · 23.976 fps · AAC stereo
* Burn-in captions: Segoe UI Semibold, white, semi-transparent black bg
* Caption sidecars: SRT (UTF-8), TTML, TXT
* Descriptive audio: ElevenLabs synthesis, R&F-standard voice, ducked −18 dB
* Naming: \`${projectId}_Master_FINAL.[ext]\`

---`
}

function buildRunningNotesMarkdown(data: ProjectCanvasData): string {
  const { projectName, projectCode } = data
  const projectId = projectCode || projectName

  return `# ${projectId} :: Running Notes

> Append-only log of decisions, change orders, blockers, and meeting notes. Kit captures automatically; producers add nuance. Per §5 of the R&F Operations Blueprint.

---

## Decisions Log

_Format: [YYYY-MM-DD HH:MM] — Decision summary — Decided by — Source link_

* —

---

## Action Items

### Open

* [ ] Owner — Item — Due

### Closed

* [x] Owner — Item — Closed date

---

## Client Feedback Summary

_Round-by-round summary; details live in Frame.io._

### Round 1 — [date]

* Frame.io link: —
* Themes: —
* Resolved in v—

---

## Meeting Notes

### [YYYY-MM-DD] — Meeting title — Attendees

* Bullet summary
* Source: Plaud / Granola transcript link

---

## Blockers

|Date|Blocker|Owner|Resolution|
|---|---|---|---|
|—|—|—|—|

---`
}

async function createSingleCanvas(opts: {
  title: string
  markdown: string
  channelId: string
  label: string
}): Promise<string | null> {
  try {
    const result = await slackPost('canvases.create', {
      title: opts.title,
      document_content: { type: 'markdown', markdown: opts.markdown },
    })
    const canvasId = result.canvas_id as string | undefined
    if (!canvasId) return null

    await slackPost('canvases.access.set', {
      canvas_id: canvasId,
      access_level: 'write',
      channel_ids: [opts.channelId],
    }).catch((err: any) => {
      console.warn(`[Slack] Could not share ${opts.label} canvas:`, err.message)
    })

    return canvasId
  } catch (err: any) {
    console.error(`[Slack] ${opts.label} canvas creation failed:`, err.message)
    return null
  }
}

/**
 * Create both project canvases (SoT + Running Notes) and post a single
 * combined link message to the channel. Each canvas creation is
 * independent — if one fails, the other still succeeds and is reported.
 */
export async function createProjectCanvases(data: ProjectCanvasData): Promise<ProjectCanvasIds> {
  if (!process.env.SLACK_BOT_TOKEN) {
    return { sotCanvasId: null, notesCanvasId: null }
  }

  const projectId = data.projectCode || data.projectName

  const [sotCanvasId, notesCanvasId] = await Promise.all([
    createSingleCanvas({
      title: `${projectId} :: SOT`,
      markdown: buildSourceOfTruthMarkdown(data),
      channelId: data.channelId,
      label: 'SoT',
    }),
    createSingleCanvas({
      title: `${projectId} :: NOTES`,
      markdown: buildRunningNotesMarkdown(data),
      channelId: data.channelId,
      label: 'Running Notes',
    }),
  ])

  // Post a single combined link message rather than two separate posts.
  const lines: string[] = []
  if (sotCanvasId) {
    lines.push(`• :clipboard: *Source of Truth* — <https://slack.com/docs/${sotCanvasId}|Open SoT>`)
  }
  if (notesCanvasId) {
    lines.push(`• :pencil: *Running Notes* — <https://slack.com/docs/${notesCanvasId}|Open Notes>`)
  }
  if (lines.length > 0) {
    await slackPost('chat.postMessage', {
      channel: data.channelId,
      text: `:notebook_with_decorative_cover: *Project canvases are ready:*\n${lines.join('\n')}`,
    }).catch(() => {})
  }

  console.log(`[Slack] Created project canvases — SoT=${sotCanvasId} Notes=${notesCanvasId}`)
  return { sotCanvasId, notesCanvasId }
}
