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
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}${formatSlackResponseMessages(data)}`)
  return data
}

/**
 * Best-effort extraction of Slack's `response_metadata.messages` for error
 * surfacing (e.g. the field-level reason behind `invalid_arguments`). Defensive
 * by contract: must NEVER throw while formatting an upstream error, and must
 * tolerate missing / non-array / malformed metadata. Returns a bounded ` (…)`
 * suffix, or '' when nothing usable is present — never raw unrelated response
 * data.
 */
export function formatSlackResponseMessages(data: SlackJson): string {
  try {
    const meta = (data as { response_metadata?: unknown }).response_metadata
    const messages = (meta as { messages?: unknown } | null | undefined)?.messages
    if (!Array.isArray(messages)) return ''
    const cleaned = messages.filter((m): m is string => typeof m === 'string').map((m) => m.trim()).filter(Boolean)
    if (cleaned.length === 0) return ''
    return ` (${cleaned.join('; ')})`
  } catch {
    return ''
  }
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

/** A single `canvases.edit` change operation (only the ops this module emits). */
export interface CanvasChange {
  operation: 'rename' | 'replace'
  title_content?: { type: 'markdown'; markdown: string }
  document_content?: { type: 'markdown'; markdown: string }
}

/**
 * Deterministic pre-flight guard for the `canvases.edit` payload, run before any
 * network transport so a malformed change set fails locally with a clear error
 * instead of surfacing as a Slack `invalid_arguments` in production. Scoped to
 * the exact contract this module emits (rename→title_content, replace→
 * document_content) — deliberately not a general schema framework.
 */
export function assertValidCanvasChanges(changes: unknown): asserts changes is CanvasChange[] {
  if (!Array.isArray(changes)) {
    throw new Error('canvases.edit: `changes` must be a native array')
  }
  // Slack accepts exactly ONE operation per canvases.edit call; a 0- or 2+-op
  // array is rejected upstream as `invalid_arguments`. Enforce it locally.
  if (changes.length !== 1) {
    throw new Error('canvases.edit: `changes` must contain exactly one operation')
  }
  for (const c of changes as CanvasChange[]) {
    if (c.operation === 'rename' && typeof c.title_content?.markdown !== 'string') {
      throw new Error('canvases.edit: rename operation requires `title_content.markdown`')
    }
    if (c.operation === 'replace' && typeof c.document_content?.markdown !== 'string') {
      throw new Error('canvases.edit: replace operation requires `document_content.markdown`')
    }
  }
}

/** Issue a single-operation `canvases.edit` against an existing canvas. */
async function editCanvasOnce(canvasId: string, change: CanvasChange): Promise<void> {
  // `changes` MUST be a native array (application/json transport) AND — per the
  // Slack contract — carry exactly ONE operation per call; a multi-op array is
  // rejected with `invalid_arguments`. The guard enforces both locally.
  const changes: CanvasChange[] = [change]
  assertValidCanvasChanges(changes)
  await slackPost('canvases.edit', { canvas_id: canvasId, changes })
}

/**
 * Full-document deterministic update of the managed canvas.
 *
 * Slack `canvases.edit` accepts only ONE operation per call, so this is TWO
 * sequential single-op requests against the same canvas_id: `replace` first
 * (the document body, which carries the H1 title, so content is correct even if
 * the rename later fails), then `rename` (the tab title). Sequential `await`
 * gives the required failure semantics: if replace throws, rename is never
 * issued; a rename failure after a successful replace propagates. Both ops are
 * deterministic full sets, so a retry (which re-issues both) is idempotent. No
 * canvas is created here; the canvas_id is never changed.
 */
export async function editControlCanvas(opts: {
  canvasId: string
  title: string
  markdown: string
}): Promise<void> {
  await editCanvasOnce(opts.canvasId, {
    operation: 'replace',
    document_content: { type: 'markdown', markdown: opts.markdown },
  })
  await editCanvasOnce(opts.canvasId, {
    operation: 'rename',
    title_content: { type: 'markdown', markdown: opts.title },
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
