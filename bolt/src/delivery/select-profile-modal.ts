// @ts-nocheck
/**
 * Profile-selection modal — opened when the user runs `/kit deliver` or
 * clicks the "Select Profile" button on a Dropbox-detected file notification.
 *
 * Block Kit view with:
 *   - read-only source file info (if attached)
 *   - profile dropdown
 *   - naming-fields inputs (dynamically derived from profile.naming_template)
 *
 * Spec: DELIVERY-PIPELINE-SPEC.md, "Profile Selection Modal".
 */

import { listProfiles, getProfile } from '../../../src/lib/delivery/storage'

const CALLBACK_ID = 'kit_delivery_select_profile'

export async function buildSelectProfileModal(opts: {
  sourcePath?: string
  sourceSizeBytes?: number
  /** Paired source files (video + optional audio) from the specs folders. */
  sources?: { path: string; type: 'video' | 'audio'; size_bytes?: number }[]
  defaultProfileId?: string
  channelId?: string
}) {
  const profiles = await listProfiles(false)
  if (profiles.length === 0) {
    return {
      type: 'modal',
      callback_id: CALLBACK_ID,
      title: { type: 'plain_text', text: 'Delivery' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'No delivery profiles exist yet. Run `/kit profiles create` to make one.' },
        },
      ],
    }
  }

  const initialProfile = opts.defaultProfileId
    ? await getProfile(opts.defaultProfileId)
    : profiles[0]

  const profileOptions = profiles.map((p) => ({
    text: { type: 'plain_text', text: p.name.slice(0, 75) },
    value: p.id,
  }))

  const blocks: any[] = []

  if (opts.sources && opts.sources.length > 0) {
    const lines = opts.sources.map((s) => {
      const icon = s.type === 'audio' ? ':musical_note:' : ':film_frames:'
      const size = s.size_bytes ? ` (${formatBytes(s.size_bytes)})` : ''
      return `${icon} *${s.type}* — \`${s.path}\`${size}`
    })
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Source files:*\n${lines.join('\n')}` },
    })
    blocks.push({ type: 'divider' })
  } else if (opts.sourcePath) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Source file:*\n:paperclip: \`${opts.sourcePath}\`${
          opts.sourceSizeBytes ? ` (${formatBytes(opts.sourceSizeBytes)})` : ''
        }`,
      },
    })
    blocks.push({ type: 'divider' })
  }

  blocks.push({
    type: 'input',
    block_id: 'profile_block',
    label: { type: 'plain_text', text: 'Delivery Profile' },
    element: {
      type: 'static_select',
      action_id: 'profile_id',
      initial_option: profileOptions.find((o) => o.value === initialProfile?.id) || profileOptions[0],
      options: profileOptions.slice(0, 100),
    },
  })

  if (initialProfile) {
    const summary = profileSummary(initialProfile)
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: summary }],
    })
  }

  // Naming fields — derived from naming_template tokens
  const tokens = initialProfile?.naming_template
    ? Array.from(new Set(initialProfile.naming_template.matchAll(/\{(\w+)\}/g))).map((m: any) => m[1])
    : []

  if (tokens.length > 0) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: 'Naming Fields' },
    })
    for (const t of tokens) {
      blocks.push({
        type: 'input',
        block_id: `name_${t}`,
        label: { type: 'plain_text', text: t.charAt(0).toUpperCase() + t.slice(1) },
        element: {
          type: 'plain_text_input',
          action_id: t,
          placeholder: { type: 'plain_text', text: `Enter ${t}` },
        },
      })
    }
  }

  // Hidden private_metadata: source files + channel id so submit handler can pick them up.
  const metadata = JSON.stringify({
    sources: opts.sources || null,
    sourcePath: opts.sourcePath || null,
    sourceSizeBytes: opts.sourceSizeBytes || null,
    channelId: opts.channelId || null,
  })

  return {
    type: 'modal',
    callback_id: CALLBACK_ID,
    private_metadata: metadata,
    title: { type: 'plain_text', text: 'Delivery Transcode' },
    submit: { type: 'plain_text', text: 'Submit Job' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  }
}

function profileSummary(p: any): string {
  const bits: string[] = []
  bits.push(p.video_codec.toUpperCase().replace('_', ' '))
  bits.push(`${p.resolution_w}x${p.resolution_h}@${p.frame_rate}`)
  bits.push(`${p.audio_channels.length}ch ${p.audio_codec.toUpperCase()}`)
  if (p.lufs_target != null) {
    bits.push(`${p.lufs_target} LUFS / ${p.true_peak_limit ?? '?'} dBTP`)
  }
  return bits.join(' • ')
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export { CALLBACK_ID as SELECT_PROFILE_CALLBACK_ID }
