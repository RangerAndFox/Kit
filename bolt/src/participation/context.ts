// @ts-nocheck
/**
 * Participation context assembly — everything Kit can ground an unprompted
 * channel reply in:
 *
 *   - knowledge:  semantic retrieval (channel brain + embedded project docs,
 *                 which includes notes and ingested call transcripts)
 *   - dashboard:  structured project state — status, delivery date, brief,
 *                 milestones, open action items (never financials)
 *   - feedback:   open feedback_items for the project
 *   - transcript: the latest call transcript snippet (guaranteed present
 *                 even if its embedding hasn't landed yet)
 *   - canvases:   the channel's Slack canvases (dashboards the team keeps)
 *   - frameio:    recent Frame.io comments — fetched only when the message
 *                 is review-flavored (comments/notes/cut/version…), since it
 *                 costs live API calls
 *
 * Everything is best-effort and parallel: any source failing yields an empty
 * block, never an error. Canvas + Frame.io results are cached briefly so a
 * chatty channel doesn't hammer external APIs.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { brainFirstRetrieve } from '../../../src/lib/brain/retrieve'
import { frameioHeaders } from '../../../src/lib/frameio/auth'
import { getAssetComments } from '../../../src/lib/frameio/client'

const FRAMEIO_API = 'https://api.frame.io/v4'

export interface ChannelProject {
  id: string
  name: string
  status: string | null
  targetDelivery: string | null
  briefSummary: string | null
  frameioUrl: string | null
  dropboxUrl: string | null
  frameioProjectId: string | null
}

export interface ParticipationContext {
  project: ChannelProject | null
  knowledgeBlock: string
  dashboardBlock: string
  feedbackBlock: string
  transcriptBlock: string
  canvasBlock: string
  frameioBlock: string
  historyBlock: string
  threadBlock: string
  roster: RosterMember[]
  hasAnySignal: boolean
}

// ─── Pure helpers (tested) ──────────────────────────────────

/** Is this message review/feedback-flavored enough to justify live Frame.io calls? */
export function wantsFrameioComments(text: string): boolean {
  return /\b(frame\.?io|review|comments?|notes?|feedback|cut|version|v\d+|approv\w*|revision)\b/i.test(
    text || '',
  )
}

/** Pull a Frame.io project id out of a stored project URL. */
export function parseFrameioProjectId(url: string | null | undefined): string | null {
  if (!url) return null
  const m = String(url).match(/frame\.io\/projects\/([a-f0-9-]+)/i)
  return m ? m[1] : null
}

function clip(s: string, max: number): string {
  const t = String(s || '').trim()
  return t.length <= max ? t : t.slice(0, max - 1) + '…'
}

// ─── Project resolution ─────────────────────────────────────

export async function resolveChannelProject(
  workspaceId: string,
  channelId: string,
): Promise<ChannelProject | null> {
  try {
    const sb = createAdminClient()
    const { data } = await sb
      .from('projects')
      .select('id, name, status, target_delivery, brief_summary, external_links, external_ids, slack_channel_id')
      .eq('workspace_id', workspaceId)
      .or(
        `external_links->>slack_id.eq.${channelId},external_links->>slack_channel_id.eq.${channelId},slack_channel_id.eq.${channelId}`,
      )
      .limit(1)
      .maybeSingle()
    if (!data) return null
    const el = data.external_links || {}
    const frameioUrl = el.frameio_url || el.frameio || null
    return {
      id: data.id,
      name: data.name,
      status: data.status || null,
      targetDelivery: data.target_delivery || null,
      briefSummary: data.brief_summary || null,
      frameioUrl,
      dropboxUrl: el.dropbox_url || el.dropbox || null,
      frameioProjectId: data.external_ids?.frameio || parseFrameioProjectId(frameioUrl),
    }
  } catch {
    return null
  }
}

// ─── Structured project data ("the dashboard") ──────────────

async function loadDashboard(workspaceId: string, project: ChannelProject | null): Promise<string> {
  if (!project) return ''
  const sb = createAdminClient()
  const lines: string[] = []
  lines.push(
    `Project: ${project.name} — status ${project.status || '?'}${project.targetDelivery ? `, target delivery ${project.targetDelivery}` : ''}`,
  )
  if (project.briefSummary) lines.push(`Brief: ${clip(project.briefSummary, 300)}`)

  try {
    const [{ data: milestones }, { data: actions }] = await Promise.all([
      sb
        .from('milestones')
        .select('title, due_date, status')
        .eq('project_id', project.id)
        .neq('status', 'completed')
        .order('due_date', { ascending: true })
        .limit(5),
      sb
        .from('kit_actions')
        .select('title, status')
        .eq('project_id', project.id)
        .in('status', ['suggested', 'pending', 'approved'])
        .limit(5),
    ])
    for (const m of milestones || []) {
      lines.push(`Milestone: ${m.title} — ${m.status}${m.due_date ? `, due ${m.due_date}` : ''}`)
    }
    for (const a of actions || []) {
      lines.push(`Open action: ${a.title}`)
    }
  } catch {
    /* best-effort */
  }
  return lines.join('\n')
}

// ─── Feedback items ─────────────────────────────────────────

async function loadFeedback(project: ChannelProject | null): Promise<string> {
  if (!project) return ''
  try {
    const sb = createAdminClient()
    const { data } = await sb
      .from('feedback_items')
      .select('content, priority, status, created_at')
      .eq('project_id', project.id)
      .in('status', ['new', 'acknowledged', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(5)
    return (data || [])
      .map((f: any) => `[${f.priority || 'normal'} · ${f.status}] ${clip(f.content, 200)}`)
      .join('\n')
  } catch {
    return ''
  }
}

// ─── Latest call transcript ─────────────────────────────────

async function loadLatestTranscript(project: ChannelProject | null): Promise<string> {
  if (!project) return ''
  try {
    const sb = createAdminClient()
    const { data } = await sb
      .from('call_transcripts')
      .select('start_time, transcript')
      .eq('project_id', project.id)
      .order('start_time', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!data?.transcript) return ''
    return `Last call (${data.start_time}): ${clip(data.transcript, 1200)}`
  } catch {
    return ''
  }
}

// ─── Channel chat history ───────────────────────────────────

export interface RosterMember {
  slackId: string
  name: string
  role: string
}

export async function loadTeamRoster(): Promise<RosterMember[]> {
  try {
    const sb = createAdminClient()
    const { data } = await sb
      .from('staff')
      .select('slack_user_id, full_name, role')
      .eq('is_active', true)
      .not('slack_user_id', 'is', null)
    return (data || []).map((s: any) => ({
      slackId: s.slack_user_id,
      name: s.full_name || s.slack_user_id,
      role: s.role || 'unknown',
    }))
  } catch {
    return []
  }
}

/**
 * Render raw Slack messages into "Name: text" lines, oldest first.
 * Pure — unit-tested. Skips system subtypes and the triggering message;
 * labels bot posts; resolves author names from the roster (unknown users
 * keep their mention form so replies can still reference them).
 */
export function formatHistoryMessages(
  messages: any[],
  names: Map<string, string>,
  excludeTs?: string,
): string {
  const lines: string[] = []
  for (const m of messages) {
    if (!m || m.ts === excludeTs) continue
    if (m.subtype && m.subtype !== 'thread_broadcast' && m.subtype !== 'bot_message') continue
    const text = clip(String(m.text || ''), 250)
    if (!text) continue
    const who = m.bot_id
      ? `${m.username || 'Kit'} (bot)`
      : names.get(m.user) || `<@${m.user}>`
    lines.push(`${who}: ${text}`)
  }
  return lines.join('\n')
}

const HISTORY_CACHE_TTL_MS = 60 * 1000
const historyCache = new Map<string, { messages: any[]; at: number }>()

/** Last ~40 channel messages, oldest→newest, cached 60s per channel. */
async function loadChannelHistory(app: App, channelId: string): Promise<any[]> {
  const hit = historyCache.get(channelId)
  if (hit && Date.now() - hit.at < HISTORY_CACHE_TTL_MS) return hit.messages
  let messages: any[] = []
  try {
    const res: any = await app.client.conversations.history({
      channel: channelId,
      limit: 40,
    })
    messages = (res.messages || []).slice().reverse() // API is newest-first
  } catch {
    messages = []
  }
  historyCache.set(channelId, { messages, at: Date.now() })
  return messages
}

/** Prior messages in the thread the question was asked in (if any). */
async function loadThreadMessages(
  app: App,
  channelId: string,
  threadTs: string | undefined,
): Promise<any[]> {
  if (!threadTs) return []
  try {
    const res: any = await app.client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 20,
    })
    return res.messages || []
  } catch {
    return []
  }
}

// ─── Channel canvases ───────────────────────────────────────

const CANVAS_CACHE_TTL_MS = 10 * 60 * 1000
const canvasCache = new Map<string, { block: string; at: number }>()

async function loadChannelCanvases(app: App, channelId: string): Promise<string> {
  const hit = canvasCache.get(channelId)
  if (hit && Date.now() - hit.at < CANVAS_CACHE_TTL_MS) return hit.block
  let block = ''
  try {
    // Canvases are files attached to the channel. Ask for canvas types; some
    // workspace configs report them as 'quip', so filter client-side too.
    const res: any = await app.client.files.list({
      channel: channelId,
      types: 'canvas',
      count: 5,
    })
    const canvases = (res.files || []).filter(
      (f: any) => f.filetype === 'canvas' || f.filetype === 'quip',
    )
    const parts: string[] = []
    for (const c of canvases.slice(0, 2)) {
      try {
        const info: any = await app.client.files.info({ file: c.id })
        const f = info?.file || {}
        // Content availability varies by API surface — take the richest we get.
        const body =
          f.plain_text || f.content || f.preview_plain_text || f.preview || ''
        parts.push(`Canvas "${f.title || c.title || 'untitled'}":\n${clip(body, 1500)}`)
      } catch {
        /* skip unreadable canvas */
      }
    }
    block = parts.join('\n\n')
  } catch {
    block = ''
  }
  canvasCache.set(channelId, { block, at: Date.now() })
  return block
}

// ─── Frame.io comments (conditional, cached) ────────────────

const FRAMEIO_CACHE_TTL_MS = 5 * 60 * 1000
const frameioCache = new Map<string, { block: string; at: number }>()

async function frameioGet(path: string): Promise<any> {
  const hdrs = await frameioHeaders()
  const res = await fetch(`${FRAMEIO_API}${path}`, {
    headers: hdrs,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Frame.io ${path}: ${res.status}`)
  return res.json()
}

async function loadFrameioComments(project: ChannelProject | null): Promise<string> {
  if (!project?.frameioProjectId) return ''
  const acct = process.env.FRAMEIO_ACCOUNT_ID
  if (!acct) return ''

  const hit = frameioCache.get(project.frameioProjectId)
  if (hit && Date.now() - hit.at < FRAMEIO_CACHE_TTL_MS) return hit.block

  let block = ''
  try {
    const detail = await frameioGet(`/accounts/${acct}/projects/${project.frameioProjectId}`)
    const proj = detail.data || detail
    const rootId = proj.root_folder_id || proj.root_asset_id
    if (rootId) {
      const kids = await frameioGet(`/accounts/${acct}/folders/${rootId}/children`)
      const files = ((kids.data || kids || []) as any[])
        .filter((c: any) => c.type === 'file')
        .sort(
          (a: any, b: any) =>
            Date.parse(b.updated_at || b.inserted_at || 0) -
            Date.parse(a.updated_at || a.inserted_at || 0),
        )
        .slice(0, 2)
      const parts: string[] = []
      for (const f of files) {
        try {
          const comments = await getAssetComments(f.id)
          const recent = comments.slice(-8)
          if (recent.length > 0) {
            parts.push(
              `Frame.io comments on "${f.name}":\n` +
                recent
                  .map(
                    (c) =>
                      `- ${c.ownerName}${c.completed ? ' [done]' : ''}: ${clip(c.text, 160)}`,
                  )
                  .join('\n'),
            )
          }
        } catch {
          /* skip file */
        }
      }
      block = parts.join('\n\n')
    }
  } catch {
    block = ''
  }
  frameioCache.set(project.frameioProjectId, { block, at: Date.now() })
  return block
}

// ─── Assembly ───────────────────────────────────────────────

export async function gatherParticipationContext(opts: {
  app: App
  workspaceId: string
  channelId: string
  messageText: string
  messageTs?: string
  threadTs?: string
}): Promise<ParticipationContext> {
  const project = await resolveChannelProject(opts.workspaceId, opts.channelId)

  const [
    retrieval,
    dashboardBlock,
    feedbackBlock,
    transcriptBlock,
    canvasBlock,
    frameioBlock,
    historyMessages,
    threadMessages,
    roster,
  ] = await Promise.all([
    brainFirstRetrieve({
      query: opts.messageText,
      channelId: opts.channelId,
      workspaceId: opts.workspaceId,
      limit: 6,
    }).catch(() => null),
    loadDashboard(opts.workspaceId, project),
    loadFeedback(project),
    loadLatestTranscript(project),
    loadChannelCanvases(opts.app, opts.channelId),
    wantsFrameioComments(opts.messageText)
      ? loadFrameioComments(project)
      : Promise.resolve(''),
    loadChannelHistory(opts.app, opts.channelId),
    loadThreadMessages(opts.app, opts.channelId, opts.threadTs),
    loadTeamRoster(),
  ])

  const names = new Map(roster.map((m) => [m.slackId, m.name]))
  const historyBlock = formatHistoryMessages(historyMessages, names, opts.messageTs)
  const threadBlock = formatHistoryMessages(threadMessages, names, opts.messageTs)

  // Respect brain visibility: producers-only brain content must not be
  // volunteered into the channel — use only general project docs then.
  let knowledgeResults = retrieval?.results || []
  if (retrieval?.brainId) {
    try {
      const sb = createAdminClient()
      const { data: brainRow } = await sb
        .from('brains')
        .select('visibility')
        .eq('id', retrieval.brainId)
        .maybeSingle()
      if (brainRow?.visibility === 'producers_only') {
        knowledgeResults = retrieval?.generalResults || []
      }
    } catch {
      knowledgeResults = retrieval?.generalResults || []
    }
  }
  const knowledgeBlock = knowledgeResults
    .slice(0, 6)
    .map((r: any, i: number) => `${i + 1}. [${r.title}] ${clip(r.content, 500)}`)
    .join('\n')

  const hasAnySignal = !!(
    project ||
    knowledgeBlock ||
    dashboardBlock ||
    feedbackBlock ||
    transcriptBlock ||
    canvasBlock ||
    frameioBlock ||
    historyBlock ||
    threadBlock
  )

  return {
    project,
    knowledgeBlock,
    dashboardBlock,
    feedbackBlock,
    transcriptBlock,
    canvasBlock,
    frameioBlock,
    historyBlock,
    threadBlock,
    roster,
    hasAnySignal,
  }
}

/** Test helper. */
export function _resetParticipationContextCachesForTest(): void {
  canvasCache.clear()
  frameioCache.clear()
}
