/**
 * Slack Project Control Canvas — dedicated create / edit / reconcile.
 *
 * The Project Control Canvas is fully Kit-managed: rendered deterministically
 * from the stored template snapshot + the authoritative Sheet row. This module
 * only ever touches ONE canvas per project (the persisted canvas_id); the other
 * cloned template canvases are never read or written here.
 *
 * Raw bot-token calls (no Bolt App dependency) so the Vercel/Inngest sync can
 * reuse the exact same edit path as Railway creation.
 */

import { createHash } from 'node:crypto'
import { fetchTemplateCandidates } from '@/lib/mcp/slack'
import { resolveProjectControlTemplate, type TemplateResolution } from './template-signature'
import type { WorkbookConfig } from './types'

const SLACK_API = 'https://slack.com/api'

interface SlackJson {
  ok?: boolean
  error?: string
  [k: string]: unknown
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    'Content-Type': 'application/json; charset=utf-8',
  }
}

async function slackPost(method: string, body: Record<string, unknown>): Promise<SlackJson> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as SlackJson
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`)
  return data
}

async function slackGet(method: string, params: Record<string, string>): Promise<SlackJson> {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${SLACK_API}/${method}?${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  })
  const data = (await res.json()) as SlackJson
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`)
  return data
}

/** Deterministic title for a project's Project Control Canvas. */
export function controlCanvasTitle(spine: string): string {
  return `${spine} — Project Control`
}

export function hashTemplate(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex')
}

export type ControlTemplateResolution =
  | { ok: true; fileId: string; markdown: string; hash: string }
  | { ok: false; reason: 'none' | 'multiple'; matchedFileIds: string[] }

/**
 * Resolve the single Project Control template (config override first, else
 * structural signature over the template channel). Fails closed on 0/2+.
 */
export async function resolveControlTemplate(config: WorkbookConfig): Promise<ControlTemplateResolution> {
  const candidates = await fetchTemplateCandidates()
  const r = resolveProjectControlTemplate(candidates, config.controlTemplateFileId)
  if (r.ok) {
    const ok = r as Extract<TemplateResolution, { ok: true }>
    return { ok: true, fileId: ok.fileId, markdown: ok.markdown, hash: hashTemplate(ok.markdown) }
  }
  const fail = r as Extract<TemplateResolution, { ok: false }>
  return { ok: false, reason: fail.reason, matchedFileIds: fail.matchedFileIds }
}

export interface CanvasHandle {
  canvasId: string
  canvasUrl: string | null
}

/** Create the managed canvas once and grant the channel write access. */
export async function createControlCanvas(opts: {
  channelId: string
  title: string
  markdown: string
}): Promise<CanvasHandle> {
  const created = await slackPost('canvases.create', {
    title: opts.title,
    channel_id: opts.channelId,
    document_content: { type: 'markdown', markdown: opts.markdown },
  })
  const canvasId = created.canvas_id as string | undefined
  if (!canvasId) throw new Error('canvases.create returned no canvas_id')
  try {
    await slackPost('canvases.access.set', {
      canvas_id: canvasId,
      access_level: 'write',
      channel_ids: [opts.channelId],
    })
  } catch (err) {
    // Non-fatal: the canvas exists and is tabbed; access upgrade can be retried.
    console.warn('[project-control canvas] access.set failed:', (err as Error).message)
  }
  return { canvasId, canvasUrl: (created.canvas_url as string | undefined) || null }
}

/** Full-document deterministic replace of the managed canvas (rename + replace). */
export async function editControlCanvas(opts: {
  canvasId: string
  title: string
  markdown: string
}): Promise<void> {
  // canvases.edit requires `changes` as a JSON-encoded STRING (Bolt/web-api does
  // not reliably auto-stringify it). Raw fetch avoids that gotcha entirely.
  const changes = [
    { operation: 'rename', title_content: { type: 'markdown', markdown: opts.title } },
    { operation: 'replace', document_content: { type: 'markdown', markdown: opts.markdown } },
  ]
  await slackPost('canvases.edit', {
    canvas_id: opts.canvasId,
    changes: JSON.stringify(changes),
  })
}

export type CanvasReconcile =
  | { status: 'found'; canvasId: string }
  | { status: 'absent' }
  | { status: 'ambiguous'; canvasIds: string[] }

/**
 * After an ambiguous create (create call errored/timed out with unknown
 * outcome), inspect ONLY this project's channel and match the exact
 * deterministic Project Control title. Bind when exactly one exists; stop
 * visibly when multiple exist; report absent when none.
 */
export async function reconcileControlCanvas(opts: {
  channelId: string
  expectedTitle: string
}): Promise<CanvasReconcile> {
  const res = await slackGet('files.list', {
    channel: opts.channelId,
    types: 'canvases',
    count: '100',
  })
  const files = (res.files as Array<{ id: string; title?: string; name?: string }>) || []
  const matches = files.filter((f) => (f.title || f.name) === opts.expectedTitle)
  if (matches.length === 1) return { status: 'found', canvasId: matches[0].id }
  if (matches.length === 0) return { status: 'absent' }
  return { status: 'ambiguous', canvasIds: matches.map((f) => f.id) }
}
