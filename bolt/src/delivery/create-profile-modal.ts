// @ts-nocheck
/**
 * Profile-creation modal — minimal version.
 *
 * Captures the most-used fields. The full spec lists many more (color space,
 * audio channel layout per channel, QC checklist editor, pixel-map URL) —
 * those are reachable via direct Supabase edits or a future edit modal.
 * v1 surfaces the essentials.
 */

const CALLBACK_ID = 'kit_delivery_create_profile'

const VIDEO_CODECS = [
  ['prores_422_proxy', 'ProRes 422 Proxy'],
  ['prores_422_lt', 'ProRes 422 LT'],
  ['prores_422', 'ProRes 422'],
  ['prores_422_hq', 'ProRes 422 HQ'],
  ['prores_4444', 'ProRes 4444'],
  ['h264', 'H.264 (web)'],
  ['h264_broadcast', 'H.264 (broadcast 15M VBR)'],
  ['dnxhr_hq', 'DNxHR HQ'],
  ['dnxhr_hqx', 'DNxHR HQX'],
]

const FRAME_RATES = ['23.976', '24', '25', '29.97', '30', '50', '59.94', '60']

const AUDIO_CODECS = [
  ['pcm_s16le', 'PCM 16-bit'],
  ['pcm_s24le', 'PCM 24-bit'],
  ['aac', 'AAC'],
]

const CONTAINERS = ['mov', 'mp4', 'mxf']

export function buildCreateProfileModal() {
  return {
    type: 'modal',
    callback_id: CALLBACK_ID,
    title: { type: 'plain_text', text: 'Create Delivery Profile' },
    submit: { type: 'plain_text', text: 'Save Profile' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      input('name', 'Profile Name', { placeholder: 'Microsoft Ignite 2025' }),
      input('description', 'Description', { placeholder: 'ProRes 422, stereo, -24 LUFS', optional: true }),

      header('Video'),
      select('video_codec', 'Codec', VIDEO_CODECS.map(([v, t]) => ({ value: v, text: t })), 'prores_422'),
      input('resolution_w', 'Width', { placeholder: '1920' }),
      input('resolution_h', 'Height', { placeholder: '1080' }),
      select('frame_rate', 'Frame Rate', FRAME_RATES.map((r) => ({ value: r, text: r })), '59.94'),

      header('Audio'),
      select('audio_codec', 'Codec', AUDIO_CODECS.map(([v, t]) => ({ value: v, text: t })), 'pcm_s24le'),
      input('audio_channels_count', 'Channel Count', { placeholder: '2' }),

      header('Loudness (leave blank to skip normalization)'),
      input('lufs_target', 'Target LUFS', { placeholder: '-24', optional: true }),
      input('true_peak_limit', 'True Peak Limit (dBTP)', { placeholder: '-10', optional: true }),

      header('Output'),
      select('container', 'Container', CONTAINERS.map((c) => ({ value: c, text: `.${c}` })), 'mov'),
      input('naming_template', 'Naming Template', { placeholder: '{session}_{speaker}_V{version}_{event}' }),

      header('QC Checklist (one per line)'),
      input('qc_checklist', 'Items', {
        placeholder: 'File name includes session code\nAudio post pass completed\nNo flash frames',
        multiline: true,
        optional: true,
      }),
    ],
  }
}

function input(id: string, label: string, opts: { placeholder?: string; optional?: boolean; multiline?: boolean } = {}) {
  return {
    type: 'input',
    block_id: id,
    label: { type: 'plain_text', text: label },
    optional: !!opts.optional,
    element: {
      type: 'plain_text_input',
      action_id: 'value',
      multiline: !!opts.multiline,
      ...(opts.placeholder ? { placeholder: { type: 'plain_text', text: opts.placeholder } } : {}),
    },
  }
}

function select(id: string, label: string, options: Array<{ value: string; text: string }>, initial?: string) {
  const opts = options.map((o) => ({
    text: { type: 'plain_text', text: o.text },
    value: o.value,
  }))
  return {
    type: 'input',
    block_id: id,
    label: { type: 'plain_text', text: label },
    element: {
      type: 'static_select',
      action_id: 'value',
      options: opts,
      ...(initial ? { initial_option: opts.find((o) => o.value === initial) || opts[0] } : {}),
    },
  }
}

function header(text: string) {
  return { type: 'header', text: { type: 'plain_text', text } }
}

export { CALLBACK_ID as CREATE_PROFILE_CALLBACK_ID }
