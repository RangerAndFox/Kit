// @ts-nocheck
/**
 * Slack canvas API wrapper.
 *
 * Uses Bolt's `app.client` for auth + retries.
 * Channel-canvas model: one canvas per channel via conversations.canvases.create.
 * If a channel already has a canvas, we error and ask the operator to clear it
 * (covered in spec §10 Open Questions).
 */

import type { App } from '@slack/bolt'

export interface CanvasHandle {
  canvas_id: string
  canvas_url: string | null
}

export async function createOrGetChannelCanvas(opts: {
  app: App
  channelId: string
  initialMarkdown: string
  title?: string
}): Promise<CanvasHandle> {
  const { app, channelId, initialMarkdown, title } = opts
  // Check for existing channel canvas first (conversations.info exposes a
  // `properties.canvas` block when one exists).
  try {
    const info = await app.client.conversations.info({ channel: channelId })
    const existing = (info as any)?.channel?.properties?.canvas
    if (existing?.file_id) {
      return {
        canvas_id: existing.file_id,
        canvas_url: existing.quip_thread_id || null,
      }
    }
  } catch (err: any) {
    // Non-fatal — fall through and try to create.
    console.warn('[shotlist] conversations.info failed:', err.message)
  }

  // The `title` parameter populates the canvas's displayed name (the tab in
  // the channel's Canvas section). Without it, Slack defaults the tab to
  // "Untitled" — the markdown H1 only affects the document body, not the
  // tab/sidebar label.
  const createPayload: any = {
    channel_id: channelId,
    document_content: { type: 'markdown', markdown: initialMarkdown },
  }
  if (title) createPayload.title = title

  const created = await app.client.conversations.canvases.create(createPayload)
  return {
    canvas_id: (created as any).canvas_id,
    canvas_url: (created as any).canvas_url || null,
  }
}

export async function updateCanvasMarkdown(opts: {
  app: App
  canvasId: string
  markdown: string
  title?: string
}): Promise<void> {
  const { app, canvasId, markdown, title } = opts

  // Two changes per edit: a `rename` to update the canvas's displayed title
  // (the tab name in Slack), and a `replace` to swap the markdown content.
  // The rename op uses `title_content` (not `document_content`) per Slack docs:
  // https://docs.slack.dev/reference/methods/canvases.edit
  const changes: any[] = []
  if (title) {
    changes.push({
      operation: 'rename',
      title_content: { type: 'markdown', markdown: title },
    })
  }
  changes.push({
    operation: 'replace',
    document_content: { type: 'markdown', markdown },
  })

  await (app.client as any).canvases.edit({
    canvas_id: canvasId,
    changes,
  })
}
