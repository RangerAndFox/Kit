// @ts-nocheck
/**
 * Frame.io → Slack Integration
 *
 * Detects Frame.io review/player links in Slack messages,
 * extracts review notes into an xlsx, and uploads it as
 * a reply in the same thread.
 */

import { detectFrameIoLink } from './client'
import { extractFrameIoNotes } from './notes-extractor'
import { createAdminClient } from '@/lib/supabase/admin'

const SLACK_API = 'https://slack.com/api'

function slackHeaders() {
  return {
    Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
  }
}

/**
 * Check if a Slack message contains a Frame.io link.
 * Returns the parsed link info or null.
 */
export function messageHasFrameIoLink(text: string): boolean {
  return detectFrameIoLink(text) !== null
}

/**
 * Process a Frame.io link from a Slack message:
 * 1. Post a "working on it" reaction
 * 2. Extract notes and build xlsx
 * 3. Upload xlsx to the Slack thread
 * 4. Post a summary message
 */
export async function handleFrameIoLink(opts: {
  text: string
  channelId: string
  threadTs: string
  messageTs: string
  userId: string
  workspaceId?: string
}): Promise<void> {
  const { text, channelId, threadTs, messageTs, userId, workspaceId } = opts

  const link = detectFrameIoLink(text)
  if (!link) return

  // Add a reaction to acknowledge we're processing
  await addReaction(channelId, messageTs, 'film_frames').catch(() => {})

  try {
    // Post a status message
    const statusMsg = await postMessage(
      channelId,
      threadTs,
      `:hourglass_flowing_sand: Extracting review notes from Frame.io...`
    )

    // Run the extraction pipeline
    const result = await extractFrameIoNotes(text)

    // Save extraction data to Supabase for Figma generation
    try {
      const db = createAdminClient()
      await db.from('review_extractions' as any).insert({
        workspace_id: workspaceId || null,
        asset_id: result.assetId,
        asset_name: result.assetName,
        source_url: text,
        slack_channel_id: channelId,
        slack_thread_ts: threadTs,
        notes: result.notes.map(n => ({
          index: n.index,
          timecode: n.timecode,
          timecodeSeconds: n.timecodeSeconds,
          note: n.note,
          author: n.author,
          authorEmail: n.authorEmail,
          date: n.date,
          completed: n.completed,
        })),
        total_comments: result.totalComments,
        thumbnails_found: result.thumbnailsFound,
      })
      console.log('[FrameIO] Extraction data saved to Supabase')
    } catch (saveErr: any) {
      // Non-critical — xlsx still uploads even if save fails
      console.warn('[FrameIO] Could not save extraction data:', saveErr.message)
    }

    // Upload the xlsx to Slack
    const filename = `${sanitizeFilename(result.assetName)}_review_notes.xlsx`
    await uploadFile({
      channelId,
      threadTs,
      filename,
      fileBuffer: result.xlsxBuffer,
      initialComment: buildSummaryMessage(result),
    })

    // Remove the status message
    if (statusMsg?.ts) {
      await deleteMessage(channelId, statusMsg.ts).catch(() => {})
    }

    // Swap reaction to checkmark
    await removeReaction(channelId, messageTs, 'film_frames').catch(() => {})
    await addReaction(channelId, messageTs, 'white_check_mark').catch(() => {})
  } catch (err: any) {
    console.error('[FrameIO→Slack] Extraction failed:', err)

    // Post error message
    await postMessage(
      channelId,
      threadTs,
      `:warning: Couldn't extract review notes: ${err.message || 'Unknown error'}`
    )

    // Swap reaction to warning
    await removeReaction(channelId, messageTs, 'film_frames').catch(() => {})
    await addReaction(channelId, messageTs, 'warning').catch(() => {})
  }
}

// ─── Slack API Helpers ──────────────────────────────────────

async function postMessage(
  channel: string,
  threadTs: string,
  text: string
): Promise<any> {
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: { ...slackHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  })
  const data = await res.json()
  if (!data.ok) console.error('[Slack] postMessage failed:', data.error)
  return data
}

async function deleteMessage(channel: string, ts: string): Promise<void> {
  await fetch(`${SLACK_API}/chat.delete`, {
    method: 'POST',
    headers: { ...slackHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, ts }),
  })
}

async function addReaction(channel: string, timestamp: string, name: string): Promise<void> {
  await fetch(`${SLACK_API}/reactions.add`, {
    method: 'POST',
    headers: { ...slackHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, timestamp, name }),
  })
}

async function removeReaction(channel: string, timestamp: string, name: string): Promise<void> {
  await fetch(`${SLACK_API}/reactions.remove`, {
    method: 'POST',
    headers: { ...slackHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, timestamp, name }),
  })
}

/**
 * Upload a file to Slack using the v2 files.uploadV2 flow:
 * 1. Get an upload URL via files.getUploadURLExternal
 * 2. POST the file to that URL
 * 3. Complete the upload via files.completeUploadExternal
 */
async function uploadFile(opts: {
  channelId: string
  threadTs: string
  filename: string
  fileBuffer: Buffer
  initialComment?: string
}): Promise<void> {
  const { channelId, threadTs, filename, fileBuffer, initialComment } = opts

  // Step 1: Get upload URL
  const getUrlRes = await fetch(`${SLACK_API}/files.getUploadURLExternal`, {
    method: 'POST',
    headers: { ...slackHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      filename,
      length: String(fileBuffer.length),
    }),
  })
  const getUrlData = await getUrlRes.json()
  if (!getUrlData.ok) {
    throw new Error(`Slack files.getUploadURLExternal: ${getUrlData.error}`)
  }

  const { upload_url, file_id } = getUrlData

  // Step 2: Upload file content
  const formData = new FormData()
  formData.append('file', new Blob([fileBuffer]), filename)

  const uploadRes = await fetch(upload_url, {
    method: 'POST',
    body: formData,
  })
  if (!uploadRes.ok) {
    throw new Error(`Slack file upload: ${uploadRes.status}`)
  }

  // Step 3: Complete the upload (share to channel/thread)
  const completeRes = await fetch(`${SLACK_API}/files.completeUploadExternal`, {
    method: 'POST',
    headers: { ...slackHeaders(), 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      files: [{ id: file_id, title: filename }],
      channel_id: channelId,
      thread_ts: threadTs,
      initial_comment: initialComment || '',
    }),
  })
  const completeData = await completeRes.json()
  if (!completeData.ok) {
    throw new Error(`Slack files.completeUploadExternal: ${completeData.error}`)
  }
}

// ─── Helpers ────────────────────────────────────────────────

function buildSummaryMessage(result: {
  assetName: string
  totalComments: number
  thumbnailsFound: number
}): string {
  const lines = [
    `:clipboard: *Review notes extracted for "${result.assetName}"*`,
    `*${result.totalComments}* notes found`,
  ]
  if (result.thumbnailsFound > 0) {
    // v4 exposes only the asset's poster frame — not per-timecode captures.
    lines.push('poster frame included')
  }
  return lines.join(' · ')
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')       // strip extension
    .replace(/[^a-zA-Z0-9_-]/g, '_')  // safe chars only
    .replace(/_+/g, '_')
    .slice(0, 60)
}
