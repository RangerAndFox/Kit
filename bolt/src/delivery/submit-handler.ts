// @ts-nocheck
/**
 * Slack view_submission handlers for the two delivery modals.
 */

import type { App } from '@slack/bolt'
import { submitJob, createProfile } from '../../../src/lib/delivery/storage'
import { SELECT_PROFILE_CALLBACK_ID, buildSelectProfileModal } from './select-profile-modal'
import { CREATE_PROFILE_CALLBACK_ID } from './create-profile-modal'
import { PICK_SPEC_ACTION, PROVIDE_SPECS_ACTION } from '../../../src/lib/delivery/specs-watcher'
import { runSpecExtraction } from './spec-intake'

const SPEC_TEXT_CALLBACK_ID = 'kit_delivery_spec_text'

export function registerDeliveryViewHandlers(app: App) {
  // Select-profile modal → submit a render job
  app.view(SELECT_PROFILE_CALLBACK_ID, async ({ ack, body, view, client }) => {
    await ack()
    const state = view.state.values
    const userId = body.user.id

    const profileId = state['profile_block']?.['profile_id']?.selected_option?.value
    if (!profileId) {
      await client.chat.postMessage({
        channel: userId,
        text: ':warning: Couldn\'t read the selected profile — please try again.',
      })
      return
    }

    const metadata = (() => {
      try { return JSON.parse(view.private_metadata || '{}') } catch { return {} }
    })()

    const namingFields: Record<string, string> = {}
    for (const [blockId, fields] of Object.entries(state)) {
      if (!blockId.startsWith('name_')) continue
      const key = blockId.slice('name_'.length)
      const value = Object.values(fields as any)[0]?.value
      if (value) namingFields[key] = String(value).trim()
    }

    // Prefer the paired video+audio sources from the specs prompt; fall back
    // to the legacy single sourcePath (manual `/kit deliver <path>`).
    const sourceFiles = Array.isArray(metadata.sources) && metadata.sources.length > 0
      ? metadata.sources.map((s: any) => ({
          path: s.path,
          type: s.type === 'audio' ? 'audio' : 'video',
          size_bytes: s.size_bytes || 0,
        }))
      : metadata.sourcePath
        ? [{ path: metadata.sourcePath, type: 'video', size_bytes: metadata.sourceSizeBytes || 0 }]
        : []

    if (sourceFiles.length === 0) {
      // No file attached (manual /kit deliver from a command). Open a follow-up
      // message asking the user to drop a Dropbox path.
      await client.chat.postMessage({
        channel: metadata.channelId || userId,
        text:
          ':inbox_tray: Delivery profile selected. To start a transcode, drop a Dropbox-synced file path here or reply with the path (e.g. `/Delivery-Queue/Ignite/intro.mov`).',
      })
      return
    }

    try {
      const job = await submitJob({
        profileId,
        sourceFiles,
        namingFields,
        requestedBy: userId,
        slackChannel: metadata.channelId || undefined,
      })
      await client.chat.postMessage({
        channel: metadata.channelId || userId,
        text:
          `:package: *Transcode job submitted*\n` +
          `Source: \`${sourceFiles[0].path}\`\n` +
          `Job: \`${job?.id}\`\n` +
          `Queued — waiting for render worker...`,
      })
    } catch (err: any) {
      await client.chat.postMessage({
        channel: metadata.channelId || userId,
        text: `:x: Couldn't submit the job: ${err.message || err}`,
      })
    }
  })

  // Create-profile modal → insert into delivery_profiles
  app.view(CREATE_PROFILE_CALLBACK_ID, async ({ ack, body, view, client }) => {
    await ack()
    const state = view.state.values
    const userId = body.user.id

    const getV = (id: string) => {
      const block = state[id]
      if (!block) return undefined
      const field: any = Object.values(block)[0]
      return field?.value ?? field?.selected_option?.value
    }

    const channelCount = parseInt(getV('audio_channels_count') || '2', 10)
    const audioChannels = Array.from({ length: channelCount }, (_, i) => ({
      channel: i + 1,
      label: i === 0 ? 'Stereo Mix Left' : i === 1 ? 'Stereo Mix Right' : `Ch ${i + 1}`,
      source: i === 0 ? 'L' : i === 1 ? 'R' : 'silent',
    }))

    const qcText = getV('qc_checklist') || ''
    const qcChecklist = qcText
      .split('\n')
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0)

    const profileInput: any = {
      name: getV('name'),
      description: getV('description') || null,
      created_by: userId,
      video_codec: getV('video_codec') || 'prores_422',
      resolution_w: parseInt(getV('resolution_w') || '1920', 10),
      resolution_h: parseInt(getV('resolution_h') || '1080', 10),
      frame_rate: getV('frame_rate') || '59.94',
      audio_codec: getV('audio_codec') || 'pcm_s24le',
      audio_channels: audioChannels,
      lufs_target: getV('lufs_target') ? parseFloat(getV('lufs_target')) : null,
      true_peak_limit: getV('true_peak_limit') ? parseFloat(getV('true_peak_limit')) : null,
      container: getV('container') || 'mov',
      naming_template: getV('naming_template') || null,
      qc_checklist: qcChecklist,
    }

    try {
      const profile = await createProfile(profileInput)
      await client.chat.postMessage({
        channel: userId,
        text: `:white_check_mark: Created delivery profile *${profile?.name}*.`,
      })
    } catch (err: any) {
      await client.chat.postMessage({
        channel: userId,
        text: `:x: Couldn't create profile: ${err.message || err}`,
      })
    }
  })

  // "Pick delivery spec" button (from the specs-folder channel prompt) → open
  // the profile picker pre-loaded with the paired video+audio sources.
  app.action(PICK_SPEC_ACTION, async ({ ack, body, client }) => {
    await ack()
    let sources: any[] = []
    try {
      sources = JSON.parse((body as any).actions?.[0]?.value || '{}').sources || []
    } catch {
      /* ignore — opens an empty picker */
    }
    const channelId = (body as any).channel?.id || (body as any).container?.channel_id
    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: (await buildSelectProfileModal({ sources, channelId })) as any,
      })
    } catch (err: any) {
      console.error('[Bolt] pick-spec modal open failed:', err.data?.error || err.message)
    }
  })

  // "Provide specs" button → modal to paste this event's spec as text.
  app.action(PROVIDE_SPECS_ACTION, async ({ ack, body, client }) => {
    await ack()
    const value = (body as any).actions?.[0]?.value || '{}'
    const channelId = (body as any).channel?.id || (body as any).container?.channel_id || ''
    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: 'modal',
          callback_id: SPEC_TEXT_CALLBACK_ID,
          private_metadata: JSON.stringify({ ...JSON.parse(value), channelId }),
          title: { type: 'plain_text', text: 'Delivery spec' },
          submit: { type: 'plain_text', text: 'Extract & render' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'input',
              block_id: 'spec_text',
              label: { type: 'plain_text', text: "Paste this event's delivery spec" },
              element: {
                type: 'plain_text_input',
                action_id: 'v',
                multiline: true,
                placeholder: {
                  type: 'plain_text',
                  text: 'e.g. ProRes 422 HQ, 1920x1080, 29.97fps, PCM 24-bit stereo @48k, -24 LUFS / -2 dBTP, .mov',
                },
              },
            },
          ],
        } as any,
      })
    } catch (err: any) {
      console.error('[Bolt] provide-specs modal open failed:', err.data?.error || err.message)
    }
  })

  // Spec-text modal submit → extract → create a profile → submit the render.
  app.view(SPEC_TEXT_CALLBACK_ID, async ({ ack, body, view, client }) => {
    const meta = (() => {
      try { return JSON.parse(view.private_metadata || '{}') } catch { return {} }
    })()
    const text = view.state.values['spec_text']?.['v']?.value?.trim()
    if (!text) {
      await ack({ response_action: 'errors', errors: { spec_text: 'Paste the spec to extract.' } })
      return
    }
    await ack()
    const userId = body.user.id
    const channel = meta.channelId || userId
    const sources = Array.isArray(meta.sources) ? meta.sources : []

    try {
      const text2 = await runSpecExtraction({ input: { text }, sources, userId, channel })
      await client.chat.postMessage({ channel, text: text2 })
    } catch (err: any) {
      await client.chat.postMessage({ channel, text: `:x: Couldn't extract/submit the spec: ${err.message || err}` })
    }
  })
}
