// @ts-nocheck
/**
 * Shot list handler — orchestrates parse → canvas create/update → confirm.
 *
 * Entry point: handleShotListMessage({ app, channelId, userId, text }).
 * Returns true if the message was handled, false otherwise.
 */

import type { App } from '@slack/bolt'
import { parseScript, parseMutation } from './parser'
import { renderShotsToMarkdown } from './renderer'
import { createOrGetChannelCanvas, updateCanvasMarkdown } from './canvas'
import { findShotListByChannel, upsertShotList } from './storage'
import { extractScriptBody } from './keyword'
import { createAdminClient } from '../../../src/lib/supabase/admin'

async function resolveProjectForChannel(
  channelId: string,
): Promise<{ id: string; name: string | null; project_code: string | null } | null> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('projects')
    .select('id, name, project_code, external_links')
    .or(`external_links->>slack_id.eq.${channelId},external_links->>slack_channel_id.eq.${channelId}`)
    .maybeSingle()
  if (!data?.id) return null
  return { id: data.id, name: data.name ?? null, project_code: data.project_code ?? null }
}

/**
 * Build the canvas title from the resolved project, if any. Falls back to the
 * generic "Shot List" when the channel isn't linked to a project (free-form
 * channels still get a working canvas, just without the project prefix).
 */
function buildCanvasTitle(
  project: { name: string | null; project_code: string | null } | null,
): string {
  const label = project?.name?.trim() || project?.project_code?.trim() || null
  return label ? `${label}_Shot List` : 'Shot List'
}

export async function handleShotListMessage(opts: {
  app: App
  channelId: string
  userId: string
  text: string
  threadTs?: string
}): Promise<boolean> {
  const { app, channelId, userId, text } = opts
  const existing = await findShotListByChannel(channelId)

  // Decide mode: if there's no existing list OR the message contains a fresh
  // script body, treat as parseScript. Otherwise parseMutation.
  const scriptCandidate = extractScriptBody(text)
  // If we have an existing list, almost everything is a mutation. Only
  // treat it as a fresh script if the user clearly hands us new script-like
  // content (long body with line breaks, or explicit "from this:" prefix).
  const looksLikeFreshScript =
    /from\s+(?:this\s*)?:/i.test(text) ||
    (scriptCandidate.length > 80 && scriptCandidate.includes('\n'))

  let shots
  try {
    if (existing && existing.shots_json && existing.shots_json.length > 0 && !looksLikeFreshScript) {
      const mutation = await parseMutation(text, existing.shots_json)
      shots = applyMutation(existing.shots_json, mutation)
    } else {
      shots = await parseScript(scriptCandidate.length > 30 ? scriptCandidate : text)
    }
  } catch (err: any) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: `:warning: I couldn't parse that into shots: ${err.message || err}. Try again with a script or numbered shot list.`,
    })
    return true
  }

  if (!shots || shots.length === 0) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: ":thinking_face: I didn't see anything I could turn into shots. Paste a script or a numbered shot list and I'll structure it for you.",
    })
    return true
  }

  const project = await resolveProjectForChannel(channelId)
  const projectId = project?.id ?? null
  const thumbnails = existing?.thumbnail_permalinks || {}
  const title = buildCanvasTitle(project)
  const markdown = renderShotsToMarkdown(shots, thumbnails, title)

  let canvas
  try {
    if (existing?.slack_canvas_id) {
      await updateCanvasMarkdown({ app, canvasId: existing.slack_canvas_id, markdown, title })
      canvas = { canvas_id: existing.slack_canvas_id, canvas_url: existing.canvas_url }
    } else {
      canvas = await createOrGetChannelCanvas({ app, channelId, initialMarkdown: markdown, title })
    }
  } catch (err: any) {
    const detail = err?.data?.error || err?.message || String(err)
    await app.client.chat.postMessage({
      channel: channelId,
      text: `:warning: I built the shot list but couldn't save it as a canvas: ${detail}. The Kit app may need the \`canvases:write\` scope — reinstall and try again.`,
    })
    return true
  }

  await upsertShotList({
    project_id: projectId,
    slack_channel_id: channelId,
    slack_canvas_id: canvas.canvas_id,
    canvas_url: canvas.canvas_url,
    shots,
    thumbnails,
  })

  await app.client.chat.postMessage({
    channel: channelId,
    text: `:clapper: Shot list ready — ${shots.length} shot${shots.length === 1 ? '' : 's'}. Open the channel Canvas tab to view. Drop image attachments in this thread to attach references to shots in order.`,
  })
  return true
}

function applyMutation(existing: any[], mutation: any): any[] {
  if (mutation.op === 'replace_all' && Array.isArray(mutation.shots)) {
    return renumber(mutation.shots)
  }
  let out = [...existing]
  if (mutation.op === 'insert' && mutation.shot) {
    const after = mutation.after_shot_number ?? out.length
    let insertAt: number
    if (after <= 0) {
      // "insert at the start" — Haiku sometimes emits after_shot_number: 0.
      insertAt = 0
    } else {
      const idx = out.findIndex((s) => s.number === after)
      insertAt = idx >= 0 ? idx + 1 : out.length
    }
    out.splice(insertAt, 0, mutation.shot)
  } else if (mutation.op === 'update' && mutation.shot && mutation.shot_number != null) {
    const idx = out.findIndex((s) => s.number === mutation.shot_number)
    if (idx >= 0) out[idx] = { ...out[idx], ...mutation.shot, number: out[idx].number }
  } else if (mutation.op === 'delete' && mutation.shot_number != null) {
    out = out.filter((s) => s.number !== mutation.shot_number)
  }
  return renumber(out)
}

function renumber(arr: any[]): any[] {
  return arr.map((s, i) => ({ ...s, number: i + 1 }))
}
