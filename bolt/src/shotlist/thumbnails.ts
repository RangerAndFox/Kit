// @ts-nocheck
/**
 * Thumbnail attachment handler for shot lists.
 *
 * When a user uploads images to a channel that has an active shot list,
 * attach the images to un-thumbnailed shots in order (lowest unfilled
 * shot number first). Re-renders the canvas after attaching.
 *
 * Spec: docs/superpowers/specs/2026-05-21-shot-list-canvas-design.md §5.
 */

import type { App } from '@slack/bolt'
import { findShotListByChannel, upsertShotList } from './storage'
import { renderShotsToMarkdown } from './renderer'
import { updateCanvasMarkdown } from './canvas'

const IMAGE_MIMETYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/heic',
])

interface SlackFile {
  id: string
  mimetype?: string
  name?: string
  permalink?: string
  permalink_public?: string
  url_private?: string
  url_private_download?: string
}

/**
 * Returns true if we attached at least one image. Returns false if the
 * message had no images or no active shot list — caller can fall through.
 */
export async function handleShotListThumbnailUpload(opts: {
  app: App
  channelId: string
  files: SlackFile[]
}): Promise<boolean> {
  const { app, channelId, files } = opts

  const images = (files || []).filter((f) =>
    f?.mimetype && IMAGE_MIMETYPES.has(f.mimetype.toLowerCase()),
  )
  if (images.length === 0) return false

  const existing = await findShotListByChannel(channelId)
  if (!existing?.slack_canvas_id) return false

  const shots = existing.shots_json || []
  if (shots.length === 0) return false

  // Build/update thumbnail map. Strategy: fill un-thumbnailed shots in
  // order with the uploaded images. If we exhaust shots, remaining images
  // are dropped on the floor (with a polite note).
  const thumbnails: Record<number, string[]> = { ...(existing.thumbnail_permalinks || {}) }

  const unfilled = shots
    .map((s) => s.number)
    .filter((n) => !thumbnails[n] || thumbnails[n].length === 0)

  let attached = 0
  let droppedForOverflow = 0
  for (const img of images) {
    const target = unfilled[attached]
    if (target == null) {
      droppedForOverflow++
      continue
    }
    const link = img.permalink_public || img.permalink || img.url_private || ''
    if (!link) continue
    thumbnails[target] = [link]
    attached++
  }

  if (attached === 0) return false

  // Re-render canvas with new thumbnails.
  const markdown = renderShotsToMarkdown(shots, thumbnails)
  try {
    await updateCanvasMarkdown({
      app,
      canvasId: existing.slack_canvas_id,
      markdown,
    })
  } catch (err: any) {
    console.error('[shotlist] canvas update for thumbnails failed:', err.message || err)
    // Still upsert the DB row so the data isn't lost; user can retry.
  }

  await upsertShotList({
    project_id: existing.project_id,
    slack_channel_id: channelId,
    slack_canvas_id: existing.slack_canvas_id,
    canvas_url: existing.canvas_url,
    shots,
    thumbnails,
  })

  const msg =
    droppedForOverflow > 0
      ? `:framed_picture: Attached ${attached} image${attached === 1 ? '' : 's'} to your shot list. ${droppedForOverflow} extra image${droppedForOverflow === 1 ? ' was' : 's were'} skipped — no more empty shots to fill.`
      : `:framed_picture: Attached ${attached} image${attached === 1 ? '' : 's'} to your shot list.`
  await app.client.chat.postMessage({
    channel: channelId,
    text: msg,
  })

  return true
}
