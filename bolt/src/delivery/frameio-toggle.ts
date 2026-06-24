// @ts-nocheck
/**
 * Per-project Frame.io upload toggle, driven conversationally.
 *
 * Lets anyone @mention or DM Kit to turn the automatic Dropbox->Frame.io
 * delivery mirror off (or on) for a single project — some projects don't use
 * Frame.io for review, and this avoids touching global config.
 *
 *   "@Kit turn off Frame.io upload"          (in a project channel)
 *   "@Kit disable frame upload for #proj"    (DM, channel reference)
 *   "@Kit turn on frame upload for project 2654"
 *   "@Kit is frame upload on?"               (status — read-only)
 *
 * Changing the setting is producer/admin only; checking status is open to all.
 *
 * This runs AFTER the Frame.io *link* fast path in the message handler, so
 * review-link messages are never captured here.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import {
  getProjectSettings,
  setFrameioUploadEnabled,
} from '../../../src/lib/projects/settings'
import type { UserContext } from '../../../src/lib/inngest/access-control'

export type FrameioToggleAction = 'enable' | 'disable' | 'status'

export interface FrameioToggleIntent {
  action: FrameioToggleAction
  /** Explicit project reference parsed from the text (for DM usage). */
  projectRef: { channelId?: string; number?: string } | null
}

// What anchors a message as a delivery-upload toggle: a "frame"/"frameio"/
// "frame.io" token, OR an "auto upload" reference. Real users routinely say
// "auto upload for <project>" without ever naming Frame.io, so we can't require
// the word "frame".
const FRAME_RE = /\bframe(?:\s?\.?\s?io)?\b/i
const AUTO_UPLOAD_RE = /\bauto[\s-]?upload(?:s|ing)?\b/i
const UPLOAD_RE = /\bupload(?:s|ing)?\b/i

// Editing / video chatter that merely says "frame" — never a toggle command.
const FRAME_NOISE_RE = /\b(frame\s?rate|framerate|key\s?frame|keyframe|per\s?frame|frames?\s+per|frame\s?\.?io\s+link)\b/i

// Imperative toggle verbs, checked before bare on/off so a polite question
// ("can you turn off the upload?") reads as a command, not a status query.
const IMP_OFF_RE = /\b(turn(?:ing)?\s+off|toggle\s+off|switch\s+off|shut\s+off|disabl\w*|deactivat\w*|stop|skip|remove|no\s+(?:frame|auto))\b/i
const IMP_ON_RE = /\b(turn(?:ing)?\s+on|toggle\s+on|switch\s+on|enabl\w*|re-?enabl\w*|reactivat\w*|activat\w*|resume|start|add)\b/i
const STATUS_RE = /\b(status|active|currently)\b/i
const BARE_OFF_RE = /\boff\b/i
const BARE_ON_RE = /\bon\b/i

const CHANNEL_MENTION_RE = /<#(C[A-Z0-9]+)(?:\|[^>]+)?>/i

/**
 * Parse the toggle intent out of a free-text message. Returns null when the
 * message isn't clearly a Frame.io / auto-upload toggle/status command.
 */
export function parseFrameioToggleIntent(text: string): FrameioToggleIntent | null {
  if (!text) return null

  const chan = text.match(CHANNEL_MENTION_RE)
  const number = parseProjectNumber(text)
  const hasProjectRef = !!(chan || number)

  const hasFrame = FRAME_RE.test(text)
  const hasAutoUpload = AUTO_UPLOAD_RE.test(text)
  const hasUpload = UPLOAD_RE.test(text)

  const isImpOff = IMP_OFF_RE.test(text)
  const isImpOn = IMP_ON_RE.test(text)
  const hasStatusWord = STATUS_RE.test(text)
  const hasToggleVerb = isImpOff || isImpOn || hasStatusWord

  // Anchor: "frame"/"frameio" or "auto upload" anchor on their own. A plain
  // "upload" needs BOTH a toggle verb and an explicit project reference to
  // count — that keeps "can you upload the final to 2628?" from matching.
  const anchored =
    hasFrame || hasAutoUpload || (hasUpload && hasToggleVerb && hasProjectRef)
  if (!anchored) return null

  // "frame rate", "keyframe", etc. — framing the image, not Frame.io. Only
  // bails when "frame" was the sole anchor (not when "auto upload" is present).
  if (hasFrame && !hasAutoUpload && FRAME_NOISE_RE.test(text)) return null

  const trimmed = text.trim()
  const isQuestion =
    /\?\s*$/.test(trimmed) ||
    /^(is|are|does|do|what|what's|whats|check|show)\b/i.test(trimmed)

  let action: FrameioToggleAction | null = null
  if (isImpOff) action = 'disable'
  else if (isImpOn) action = 'enable'
  else if (hasStatusWord || isQuestion) action = 'status'
  else if (BARE_OFF_RE.test(text)) action = 'disable'
  else if (BARE_ON_RE.test(text)) action = 'enable'
  if (!action) return null

  const projectRef = hasProjectRef ? { channelId: chan?.[1], number } : null
  return { action, projectRef }
}

/** Pull a studio project number out of the text ("project 2654", "#2654"). */
function parseProjectNumber(text: string): string | undefined {
  const explicit = text.match(/\bproject\s+#?(\d{2,6}[A-Za-z]?)\b/i)
  if (explicit) return explicit[1]
  // A bare 4-digit (optionally suffixed) code, e.g. "2654" or "2612B".
  const bare = text.match(/(?:^|[^\d])(\d{4}[A-Za-z]?)(?=$|[^\d])/)
  if (bare) return bare[1]
  return undefined
}

/**
 * Resolve the target project: an explicit reference (DM) wins, otherwise the
 * channel the message was sent in.
 */
async function resolveToggleProject(
  workspaceId: string | null,
  channelId: string,
  ref: FrameioToggleIntent['projectRef'],
): Promise<{ id: string; name: string } | null> {
  const sb = createAdminClient()

  const byChannel = async (chId: string) => {
    let q = sb.from('projects').select('id, name')
    if (workspaceId) q = q.eq('workspace_id', workspaceId)
    const { data } = await q
      .or(
        `external_links->>slack_id.eq.${chId},external_links->>slack_channel_id.eq.${chId},slack_channel_id.eq.${chId}`,
      )
      .limit(1)
      .maybeSingle()
    return data || null
  }

  const byNumber = async (num: string) => {
    const tryPattern = async (pattern: string) => {
      let q = sb.from('projects').select('id, name')
      if (workspaceId) q = q.eq('workspace_id', workspaceId)
      const { data } = await q.ilike('project_code', pattern).limit(1).maybeSingle()
      return data || null
    }
    return (await tryPattern(`${num}%`)) || (await tryPattern(`%${num}%`))
  }

  if (ref?.channelId) {
    const p = await byChannel(ref.channelId)
    if (p) return p
  }
  if (ref?.number) {
    const p = await byNumber(ref.number)
    if (p) return p
  }
  return byChannel(channelId)
}

/**
 * Handle a Frame.io-upload toggle/status message. Returns true if it owned the
 * message (so the caller stops routing), false to fall through to the
 * orchestrator.
 */
export async function handleFrameioToggleMessage(opts: {
  app: App
  channelId: string
  userId: string
  text: string
  threadTs?: string
  workspaceId: string | null
  caller: UserContext | null
}): Promise<boolean> {
  const intent = parseFrameioToggleIntent(opts.text)
  if (!intent) return false

  const post = (text: string) =>
    opts.app.client.chat.postMessage({
      channel: opts.channelId,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      text,
    })

  const project = await resolveToggleProject(opts.workspaceId, opts.channelId, intent.projectRef)
  if (!project) {
    await post(
      "I don't see a project linked to this channel. Try running this in a project channel, or include the project number (e.g. \"turn off frame upload for project 2654\").",
    )
    return true
  }

  const settings = await getProjectSettings(project.id)

  // Status is read-only — anyone can check it.
  if (intent.action === 'status') {
    await post(
      settings.frameio_upload_enabled
        ? `Frame.io upload is *on* for *${project.name}* — new deliveries upload to Frame.io automatically.`
        : `Frame.io upload is *off* for *${project.name}* — delivery files stay in Dropbox only.`,
    )
    return true
  }

  // Changing the setting is producer/admin only.
  const tier = opts.caller?.tier ?? 'artist'
  if (tier !== 'admin' && tier !== 'producer') {
    await post('Ask a producer to change delivery settings.')
    return true
  }

  const desired = intent.action === 'enable'
  if (settings.frameio_upload_enabled === desired) {
    await post(
      desired
        ? `Frame.io upload is already *enabled* for *${project.name}*.`
        : `Frame.io upload is already *disabled* for *${project.name}*.`,
    )
    return true
  }

  try {
    await setFrameioUploadEnabled(project.id, desired, opts.userId)
  } catch (err: any) {
    await post(`Couldn't update that setting: ${err?.message || 'unknown error'}`)
    return true
  }

  await post(
    desired
      ? `:white_check_mark: Frame.io upload re-enabled for *${project.name}*. New deliveries will upload to Frame.io automatically.`
      : `:white_check_mark: Frame.io upload disabled for *${project.name}*. Delivery files will stay in Dropbox only.`,
  )
  return true
}
