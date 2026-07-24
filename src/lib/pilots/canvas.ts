/**
 * Dedicated read-only pilot Canvas — create / edit.
 *
 * Mirrors the project-control canvas pattern (raw bot-token calls, injectable
 * transport, deterministic full-document replace, read-only channel access) but
 * is a SEPARATE canvas per pilot so the pilot lifecycle is never coupled to the
 * Project Control Canvas. The rendered markdown is produced by pilots/render.ts;
 * this module only performs the Slack I/O.
 */

const SLACK_API = 'https://slack.com/api'
const SLACK_CALL_TIMEOUT_MS = 15_000

/** Channel members get read-only access; Kit edits via its own app token. */
export const PILOT_CANVAS_ACCESS_LEVEL = 'read' as const

interface SlackJson {
  ok?: boolean
  error?: string
  [k: string]: unknown
}

type SlackTransport = (
  kind: 'post' | 'get',
  method: string,
  payload: Record<string, unknown>,
) => Promise<SlackJson>

function headers() {
  return {
    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    'Content-Type': 'application/json; charset=utf-8',
  }
}

async function httpTransport(
  kind: 'post' | 'get',
  method: string,
  payload: Record<string, unknown>,
): Promise<SlackJson> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SLACK_CALL_TIMEOUT_MS),
  })
  const data = (await res.json()) as SlackJson
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`)
  return data
}

let transport: SlackTransport = httpTransport

/** Test seam: swap the Slack HTTP transport for a fake. Pass null to restore. */
export function __setPilotCanvasTransportForTests(t: SlackTransport | null): void {
  transport = t || httpTransport
}

export interface PilotCanvasHandle {
  canvasId: string
  canvasUrl: string | null
}

/** Deterministic title for a pilot's Canvas. */
export function pilotCanvasTitle(title: string): string {
  return `${title} — Visual Dev Pilot`
}

/** Create the managed pilot canvas once and set the channel to read-only. */
export async function createPilotCanvas(opts: {
  channelId: string
  title: string
  markdown: string
}): Promise<PilotCanvasHandle> {
  const created = await transport('post', 'canvases.create', {
    title: opts.title,
    channel_id: opts.channelId,
    document_content: { type: 'markdown', markdown: opts.markdown },
  })
  const canvasId = created.canvas_id as string | undefined
  if (!canvasId) throw new Error('canvases.create returned no canvas_id')
  try {
    await transport('post', 'canvases.access.set', {
      canvas_id: canvasId,
      access_level: PILOT_CANVAS_ACCESS_LEVEL,
      channel_ids: [opts.channelId],
    })
  } catch (err) {
    // Non-fatal: the canvas exists; the read-only grant can be retried. The
    // generated-view notice + full re-render keep the projection contract.
    console.warn('[pilot canvas] access.set failed:', (err as Error).message)
  }
  return { canvasId, canvasUrl: (created.canvas_url as string | undefined) || null }
}

/**
 * Full-document deterministic update of the managed canvas: `replace` (body,
 * which carries the H1 title) then `rename` (tab title). Sequential await gives
 * the failure semantics; both are deterministic full sets, so a retry is
 * idempotent. The canvas_id is never changed here.
 */
export async function editPilotCanvas(opts: {
  canvasId: string
  title: string
  markdown: string
}): Promise<void> {
  await transport('post', 'canvases.edit', {
    canvas_id: opts.canvasId,
    changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown: opts.markdown } }],
  })
  await transport('post', 'canvases.edit', {
    canvas_id: opts.canvasId,
    changes: [{ operation: 'rename', title_content: { type: 'markdown', markdown: opts.title } }],
  })
}
