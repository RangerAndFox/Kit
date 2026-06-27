// @ts-nocheck
/**
 * Delivery spec intake from a thread reply.
 *
 * After Kit posts the "new delivery source" prompt, the operator replies in
 * that thread with the event's spec — as text, a PDF, or a screenshot. This
 * routes the reply through the extractor, saves the spec as a profile, and
 * submits the render with the paired video+audio.
 */

import type { App } from '@slack/bolt'
import { createProfile, submitJob } from '../../../src/lib/delivery/storage'
import { getOpenSpecIntake, consumeSpecIntake } from '../../../src/lib/delivery/spec-intake-store'
import { extractAndNormalize } from './spec-extractor'

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** Download a Slack file as base64 using the bot token. */
async function downloadSlackFile(file: any): Promise<Buffer> {
  const token = process.env.SLACK_BOT_TOKEN
  const url = file.url_private_download || file.url_private
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Slack file download ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Extract a spec from the given input, save it as a profile, and submit a
 * render job for the paired sources. Returns the confirmation text.
 */
export async function runSpecExtraction(opts: {
  input: { text?: string; image?: { base64: string; mediaType: string }; pdf?: { base64: string } }
  sources: any[]
  userId: string
  channel: string
  threadTs?: string
}): Promise<string> {
  const { spec, missing, warnings } = await extractAndNormalize(opts.input)
  const profile = await createProfile({ ...spec, created_by: opts.userId })
  if (!profile) throw new Error('could not save the extracted spec')

  const job = await submitJob({
    profileId: profile.id,
    sourceFiles: opts.sources.map((s: any) => ({
      path: s.path,
      type: s.type === 'audio' ? 'audio' : 'video',
      size_bytes: s.size_bytes || 0,
    })),
    namingFields: {},
    requestedBy: opts.userId,
    slackChannel: opts.channel,
    slackThreadTs: opts.threadTs,
  })

  const flags = [
    ...missing.map((m: string) => `:grey_question: *${m}* wasn't in the spec — defaulted; confirm it.`),
    ...warnings.map((w: string) => `:information_source: ${w}`),
  ]
  return (
    `:dart: *Extracted spec — ${spec.name}*\n` +
    `${spec.video_codec} • ${spec.resolution_w}x${spec.resolution_h}@${spec.frame_rate} • ` +
    `${spec.audio_channels.length}ch ${spec.audio_codec}` +
    (spec.lufs_target != null ? ` • ${spec.lufs_target} LUFS` : '') +
    `\nJob \`${job?.id}\` queued.` +
    (flags.length ? `\n\n${flags.join('\n')}` : '')
  )
}

/**
 * Handle a message that may be a reply to a delivery-spec prompt. Returns true
 * if it was a spec reply we handled, false otherwise (caller continues).
 */
export async function handleSpecIntakeReply(opts: {
  app: App
  channelId: string
  threadTs: string
  userId: string
  text?: string
  files?: any[]
}): Promise<boolean> {
  const intake = await getOpenSpecIntake(opts.channelId, opts.threadTs)
  if (!intake) return false

  // Build the extractor input from a screenshot, a PDF, or the reply text.
  let input: any = null
  const image = (opts.files || []).find((f) => IMAGE_TYPES.has(f.mimetype))
  const pdf = (opts.files || []).find((f) => f.mimetype === 'application/pdf')
  try {
    if (image) {
      const buf = await downloadSlackFile(image)
      input = { image: { base64: buf.toString('base64'), mediaType: image.mimetype } }
    } else if (pdf) {
      const buf = await downloadSlackFile(pdf)
      input = { pdf: { base64: buf.toString('base64') } }
    } else if (opts.text && opts.text.trim().length > 0) {
      input = { text: opts.text.trim() }
    }
  } catch (err: any) {
    await opts.app.client.chat.postMessage({
      channel: opts.channelId,
      thread_ts: opts.threadTs,
      text: `:warning: Couldn't read that attachment — paste the spec as text instead. (${err.message || err})`,
    })
    return true
  }

  if (!input) return false // nothing usable in the reply — let normal flow continue

  await opts.app.client.chat.postMessage({
    channel: opts.channelId,
    thread_ts: opts.threadTs,
    text: ':hourglass_flowing_sand: Reading the spec...',
  })

  try {
    const text = await runSpecExtraction({
      input,
      sources: intake.sources,
      userId: opts.userId,
      channel: opts.channelId,
      threadTs: opts.threadTs,
    })
    await consumeSpecIntake(intake.id)
    await opts.app.client.chat.postMessage({ channel: opts.channelId, thread_ts: opts.threadTs, text })
  } catch (err: any) {
    await opts.app.client.chat.postMessage({
      channel: opts.channelId,
      thread_ts: opts.threadTs,
      text: `:x: Couldn't extract the spec: ${err.message || err}. Try pasting it as text.`,
    })
  }
  return true
}
