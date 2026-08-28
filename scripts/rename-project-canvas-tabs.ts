/**
 * One-time/idempotent Slack migration for compact project Canvas tab titles.
 *
 * Dry run:
 *   node --env-file=.env.local --import tsx scripts/rename-project-canvas-tabs.ts
 * Apply:
 *   node --env-file=.env.local --import tsx scripts/rename-project-canvas-tabs.ts --apply
 */

import { projectCanvasTitle, type ProjectCanvasTitleType } from '../src/lib/project-control/canvas-title'
import { canvasHtmlToMarkdown } from '../src/lib/mcp/slack'

const API = 'https://slack.com/api'
const token = process.env.SLACK_BOT_TOKEN
const apply = process.argv.includes('--apply')

if (!token) throw new Error('SLACK_BOT_TOKEN is required')

type SlackChannel = { id: string; name?: string; is_archived?: boolean }
type SlackCanvas = { id: string; title?: string; name?: string }
type RenameChange = { kind: 'rename'; channel: string; canvasId: string; from: string; to: string }
type CreateChange = { kind: 'create'; channel: string; channelId: string; projectId: string; to: string }

async function slack(method: string, payload: Record<string, unknown>, kind: 'get' | 'post' = 'get') {
  const init: RequestInit = {
    method: kind === 'post' ? 'POST' : 'GET',
    headers: kind === 'post'
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }
      : { Authorization: `Bearer ${token}` },
  }
  let url = `${API}/${method}`
  if (kind === 'post') init.body = JSON.stringify(payload)
  else url += `?${new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, String(v)])).toString()}`
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) })
  const data = await response.json() as { ok?: boolean; error?: string; response_metadata?: { next_cursor?: string }; [key: string]: unknown }
  if (!data.ok) throw new Error(`${method}: ${data.error || response.status}`)
  return data
}

function canvasType(title: string): ProjectCanvasTitleType | null {
  if (/(?:—|-|_)\s*(?:notes?\s*(?:and|&)\s*feedback|notesandfeedback)\s*$/i.test(title)) return 'notesAndFeedback'
  if (/(?:—|-|_)\s*reference\s*$/i.test(title)) return 'reference'
  if (/(?:—|-|_)\s*schedule\s*$/i.test(title)) return 'schedule'
  if (/(?:—|-|_)\s*overview\s*$/i.test(title)) return 'overview'
  return null
}

async function listProjectChannels(): Promise<Array<SlackChannel & { projectId: string }>> {
  const channels: SlackChannel[] = []
  let cursor = ''
  do {
    const data = await slack('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    channels.push(...((data.channels || []) as SlackChannel[]))
    cursor = data.response_metadata?.next_cursor || ''
  } while (cursor)
  return channels.flatMap((channel) => {
    const rawProjectId = channel.name?.match(/^(\d{4}[a-z]?)(?:-|$)/i)?.[1]
    const projectId = rawProjectId?.replace(/[a-z]$/i, (letter) => letter.toUpperCase())
    return projectId ? [{ ...channel, projectId }] : []
  })
}

async function listCanvases(channelId: string): Promise<SlackCanvas[]> {
  const data = await slack('files.list', { channel: channelId, types: 'canvases', count: 100 })
  return (data.files || []) as SlackCanvas[]
}

async function loadNotesTemplate(): Promise<string> {
  const fileId = process.env.SLACK_PROJECT_NOTES_TEMPLATE_FILE_ID || 'F0B13HCFV9D'
  const info = await slack('files.info', { file: fileId })
  const file = info.file as { url_private_download?: string; url_private?: string } | undefined
  const url = file?.url_private_download || file?.url_private
  if (!url) throw new Error(`Notes template ${fileId} has no download URL`)
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new Error(`Notes template download failed: HTTP ${response.status}`)
  return canvasHtmlToMarkdown(await response.text())
}

async function main() {
  const channels = await listProjectChannels()
  const changes: Array<RenameChange | CreateChange> = []
  const conflicts: string[] = []
  const notesTemplate = await loadNotesTemplate()

  for (const channel of channels) {
    const canvases = await listCanvases(channel.id)
    const classified = canvases.flatMap((canvas) => {
      const from = canvas.title || canvas.name || ''
      const type = canvasType(from)
      return type ? [{ canvas, from, type }] : []
    })
    if (classified.length === 0) continue
    for (const type of ['overview', 'reference', 'schedule', 'notesAndFeedback'] as const) {
      const matches = classified.filter((item) => item.type === type)
      if (matches.length > 1) {
        conflicts.push(`${channel.name}: ${matches.length} ${type} canvases`)
        continue
      }
      const match = matches[0]
      if (!match) continue
      const to = projectCanvasTitle(channel.projectId, type)
      if (match.from === to) continue
      changes.push({ kind: 'rename', channel: channel.name || channel.id, canvasId: match.canvas.id, from: match.from, to })
    }
    if (!classified.some((item) => item.type === 'notesAndFeedback')) {
      changes.push({
        kind: 'create',
        channel: channel.name || channel.id,
        channelId: channel.id,
        projectId: channel.projectId,
        to: projectCanvasTitle(channel.projectId, 'notesAndFeedback'),
      })
    }
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', projectChannels: channels.length, changes: changes.length, conflicts }, null, 2))
  for (const change of changes) {
    if (change.kind === 'rename') {
      console.log(`${apply ? 'RENAME' : 'WOULD RENAME'} ${change.channel}: ${change.from} -> ${change.to}`)
      if (!apply) continue
      await slack('canvases.edit', {
        canvas_id: change.canvasId,
        changes: [{ operation: 'rename', title_content: { type: 'markdown', markdown: change.to } }],
      }, 'post')
    } else {
      console.log(`${apply ? 'CREATE' : 'WOULD CREATE'} ${change.channel}: ${change.to}`)
      if (!apply) continue
      const created = await slack('canvases.create', {
        title: change.to,
        channel_id: change.channelId,
        document_content: {
          type: 'markdown',
          markdown: notesTemplate.replace(/\b2x{2,}\b/gi, change.projectId),
        },
      }, 'post')
      const canvasId = created.canvas_id as string | undefined
      if (!canvasId) throw new Error(`canvases.create returned no ID for ${change.channel}`)
      await slack('canvases.access.set', {
        canvas_id: canvasId,
        access_level: 'read',
        channel_ids: [change.channelId],
      }, 'post')
    }
  }

  if (conflicts.length) process.exitCode = 2
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
