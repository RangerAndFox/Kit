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
}): Promise<CanvasHandle> {
  const { app, channelId, initialMarkdown } = opts
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

  const created = await app.client.conversations.canvases.create({
    channel_id: channelId,
    document_content: { type: 'markdown', markdown: initialMarkdown },
  } as any)
  return {
    canvas_id: (created as any).canvas_id,
    canvas_url: (created as any).canvas_url || null,
  }
}

export async function updateCanvasMarkdown(opts: {
  app: App
  canvasId: string
  markdown: string
}): Promise<void> {
  const { app, canvasId, markdown } = opts
  await (app.client as any).canvases.edit({
    canvas_id: canvasId,
    changes: [
      {
        operation: 'replace',
        document_content: { type: 'markdown', markdown },
      },
    ],
  })
}
