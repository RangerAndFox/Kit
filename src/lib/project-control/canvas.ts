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
import { classifyControlTemplate, type ControlTemplateClassification } from './template-signature'
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

// Bounded: an unbounded Slack call could hang past the creation lease and let a
// reclaiming worker run concurrently (see the lease-ownership guarantees).
const SLACK_CALL_TIMEOUT_MS = 15_000

/**
 * Channel access level for the managed Project Control Canvas. The Sheet is the
 * authoritative source of truth (invariant #14); ordinary channel members get
 * **read-only** access so the Canvas does not appear to be an independently
 * editable source. Slack's `canvases.access.set` accepts `'read' | 'write'`
 * (verified against @slack/web-api `CanvasesAccessSetArguments`); `channel_ids`
 * scopes the grant to channel members, not to Kit's own app token, so Kit
 * continues to edit the Canvas via `canvases.edit`. (The read + app-edit
 * interaction is confirmed at staging per the rollout runbook.)
 */
export const CONTROL_CANVAS_ACCESS_LEVEL = 'read' as const

type SlackTransport = (
  kind: 'post' | 'get',
  method: string,
  payload: Record<string, unknown> | Record<string, string>,
) => Promise<SlackJson>

async function httpTransport(
  kind: 'post' | 'get',
  method: string,
  payload: Record<string, unknown> | Record<string, string>,
): Promise<SlackJson> {
  let res: Response
  if (kind === 'post') {
    res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SLACK_CALL_TIMEOUT_MS),
    })
  } else {
    const qs = new URLSearchParams(payload as Record<string, string>).toString()
    res = await fetch(`${SLACK_API}/${method}?${qs}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      signal: AbortSignal.timeout(SLACK_CALL_TIMEOUT_MS),
    })
  }
  const data = (await res.json()) as SlackJson
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`)
  return data
}

let transport: SlackTransport = httpTransport

/** Test seam: swap the Slack HTTP transport for a fake. Pass null to restore. */
export function __setCanvasTransportForTests(t: SlackTransport | null): void {
  transport = t || httpTransport
}

function slackPost(method: string, body: Record<string, unknown>): Promise<SlackJson> {
  return transport('post', method, body)
}

function slackGet(method: string, params: Record<string, string>): Promise<SlackJson> {
  return transport('get', method, params)
}

/** Deterministic title for a project's Project Control Canvas. */
export function controlCanvasTitle(spine: string): string {
  return `${spine} — Project Control`
}

export function hashTemplate(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex')
}

export type ControlTemplateResolution =
  | { ok: true; fileId: string; markdown: string; hash: string; cloneSafe: boolean }
  | {
      ok: false
      reason: 'none' | 'multiple' | 'uncertain'
      /** Candidate ids to exclude from generic cloning (all structural matches + a configured id). */
      excludeFileIds: string[]
      /**
       * Whether it is safe to generically clone the OTHER template canvases.
       * False when enumeration was partial or a configured id couldn't be
       * verified — then the caller must skip generic cloning entirely, so no
       * unmanaged Project-Control-like canvas can slip through.
       */
      cloneSafe: boolean
    }

/**
 * Resolve the single Project Control template (config override first, else
 * structural signature over the template channel). Fails closed on 0/2+ and,
 * critically, on UNCERTAIN enumeration: when the candidate set is partial (a
 * channel/list/body fetch failed) or a configured id couldn't be verified, it
 * reports cloneSafe=false so the caller clones nothing — a Project-Control-like
 * canvas must never be generically cloned when we can't prove we've excluded it.
 */
export async function resolveControlTemplate(config: WorkbookConfig): Promise<ControlTemplateResolution> {
  const { candidates, partial } = await fetchTemplateCandidates()
  const c = classifyControlTemplate(candidates, partial, config.controlTemplateFileId)
  if (c.ok) return { ok: true, fileId: c.fileId, markdown: c.markdown, hash: hashTemplate(c.markdown), cloneSafe: c.cloneSafe }
  const fail = c as Extract<ControlTemplateClassification, { ok: false }>
  return { ok: false, reason: fail.reason, excludeFileIds: fail.excludeFileIds, cloneSafe: fail.cloneSafe }
}

export interface CanvasHandle {
  canvasId: string
  canvasUrl: string | null
}

/** Create the managed canvas once and set the channel to read-only access. */
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
      access_level: CONTROL_CANVAS_ACCESS_LEVEL,
      channel_ids: [opts.channelId],
    })
  } catch (err) {
    // Non-fatal: the canvas exists and is tabbed; the read-only grant can be
    // retried. The generated-view notice + deterministic full re-render keep the
    // one-way contract even if this grant is momentarily unset.
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
