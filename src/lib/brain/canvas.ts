// @ts-nocheck
/**
 * Render a brain to a Slack channel canvas.
 *
 * The canvas is read-only: it mirrors the markdown body with provenance
 * comments stripped, plus a small footer linking back to the brain id and
 * revision so anyone can ask `/kit brain why <claim>` for sources.
 *
 * Mirrors bolt/src/shotlist/canvas.ts conventions — Bolt's app.client for
 * auth + the conversations.canvases.create / canvases.edit pair so the
 * canvas's displayed tab title is set correctly (not "Untitled").
 *
 * Spec: KIT-BRAIN-SPEC.md §3.1
 */

import type { App } from '@slack/bolt'
import { type Brain, stripProvenance, serializeBrain } from './format'

export interface BrainCanvasHandle {
  canvas_id: string
  canvas_url: string | null
}

export function buildCanvasTitle(brain: Brain): string {
  // Use the markdown H1 if present; otherwise compose from frontmatter.
  if (brain.title) return brain.title
  const code = brain.frontmatter.project_code
  if (code) return `Brain — ${code}`
  return 'Brain'
}

export function buildCanvasMarkdown(brain: Brain): string {
  // Strip provenance, then serialize. We rebuild from the structured form
  // so the canvas always reflects current state, even if the stored
  // markdown drifted (it shouldn't, but defense in depth).
  const md = stripProvenance(serializeBrain(brain))
  const rev = brain.frontmatter.revision ?? 0
  const id = brain.frontmatter.brain_id || ''
  const footer = `\n\n---\n_Brain \`${id}\` · revision ${rev} · ask “@Kit why <claim>” for sources._\n`
  return md + footer
}

export async function createOrUpdateBrainCanvas(opts: {
  app: App
  channelId: string
  brain: Brain
  existingCanvasId?: string | null
}): Promise<BrainCanvasHandle> {
  const { app, channelId, brain, existingCanvasId } = opts
  const title = buildCanvasTitle(brain)
  const markdown = buildCanvasMarkdown(brain)

  if (existingCanvasId) {
    await updateCanvas({ app, canvasId: existingCanvasId, markdown, title })
    return { canvas_id: existingCanvasId, canvas_url: null }
  }

  // Probe the channel for an existing canvas (we may not have stored it yet).
  try {
    const info = await app.client.conversations.info({ channel: channelId })
    const existing = (info as any)?.channel?.properties?.canvas
    if (existing?.file_id) {
      await updateCanvas({ app, canvasId: existing.file_id, markdown, title })
      return {
        canvas_id: existing.file_id,
        canvas_url: existing.quip_thread_id || null,
      }
    }
  } catch (err: any) {
    console.warn('[brain.canvas] conversations.info failed:', err.message)
  }

  const created = await app.client.conversations.canvases.create({
    channel_id: channelId,
    title,
    document_content: { type: 'markdown', markdown },
  } as any)
  return {
    canvas_id: (created as any).canvas_id,
    canvas_url: (created as any).canvas_url || null,
  }
}

async function updateCanvas(opts: {
  app: App
  canvasId: string
  markdown: string
  title: string
}): Promise<void> {
  const { app, canvasId, markdown, title } = opts
  // Two edits: rename (title_content) + replace (document_content). Slack's
  // canvas tab title is independent of the document H1.
  await (app.client as any).canvases.edit({
    canvas_id: canvasId,
    changes: [
      { operation: 'rename', title_content: { type: 'markdown', markdown: title } },
      { operation: 'replace', document_content: { type: 'markdown', markdown } },
    ],
  })
}
