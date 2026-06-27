// @ts-nocheck
/**
 * Slack view_submission handlers for the two delivery modals.
 */

import type { App } from '@slack/bolt'
import { submitJob, createProfile } from '../../../src/lib/delivery/storage'
import { submitAeRenderFromProject } from '../../../src/lib/delivery/ae-storage'
import { SELECT_PROFILE_CALLBACK_ID } from './select-profile-modal'
import { CREATE_PROFILE_CALLBACK_ID } from './create-profile-modal'
import { AE_RENDER_CALLBACK_ID } from './render-modal'

export function registerDeliveryViewHandlers(app: App) {
  // AE render modal → read the project's render queue and dispatch chunks
  app.view(AE_RENDER_CALLBACK_ID, async ({ ack, body, view, client }) => {
    const projectPath = view.state.values['aep_block']?.['aep_path']?.value?.trim()
    if (!projectPath) {
      await ack({
        response_action: 'errors',
        errors: { aep_block: 'Enter the Dropbox path to the .aep' },
      })
      return
    }
    await ack()
    const userId = body.user.id
    const metadata = (() => {
      try { return JSON.parse(view.private_metadata || '{}') } catch { return {} }
    })()
    const channel = metadata.channelId || userId

    try {
      await submitAeRenderFromProject({
        projectPath,
        requestedBy: userId,
        slackChannel: channel,
      })
      await client.chat.postMessage({
        channel,
        text:
          `:clapper: *Render queued* — \`${projectPath}\`\n` +
          `Reading the project's After Effects render queue and splitting the queued comps across the studio's AE machines.\n` +
          `Track it with \`/kit render status\`.`,
      })
    } catch (err: any) {
      await client.chat.postMessage({
        channel: userId,
        text: `:x: Couldn't start the render: ${err.message || err}`,
      })
    }
  })

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

    const sourceFiles = metadata.sourcePath
      ? [{
          path: metadata.sourcePath,
          type: 'video',
          size_bytes: metadata.sourceSizeBytes || 0,
        }]
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
}
