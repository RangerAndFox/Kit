import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFFmpegArgs, buildLoudnessAnalysisArgs, loudnormTargets } from './command-builder'

const profile: any = {
  lufs_target: -24,
  true_peak_limit: -10,
  lufs_lra: 11,
  video_codec: 'prores_422',
  pixel_format: 'yuv422p10le',
  resolution_w: 1920,
  resolution_h: 1080,
  frame_rate: '59.94',
  frame_rate_mode: 'cfr',
  video_filters: null,
  color_space: null,
  video_bitrate: null,
  audio_codec: 'pcm_s24le',
  audio_sample_rate: 48000,
  audio_bitrate: null,
  audio_channels: [
    { channel: 1, label: 'Left', source: 'L' },
    { channel: 2, label: 'Right', source: 'R' },
  ],
  container: 'mov',
}

test('adapts strict true-peak specs to FFmpeg loudnorm range', () => {
  assert.deepEqual(loudnormTargets(profile), {
    integrated: -23,
    truePeak: -9,
    postGainDb: -1,
  })
  assert.match(buildLoudnessAnalysisArgs(profile, 'source.mov').join(' '), /I=-23:TP=-9/)
})

test('applies compensating gain after loudnorm in pass two', () => {
  const args = buildFFmpegArgs({
    profile,
    sourceFiles: [{ path: 'source.mov', type: 'video', size_bytes: 1 }],
    outputPath: 'out.mov',
    loudness: {
      input_i: -19,
      input_tp: -2,
      input_lra: 1,
      input_thresh: -29,
      target_offset: 0,
    },
  })
  const af = args[args.indexOf('-af') + 1]
  assert.match(af, /loudnorm=I=-23:TP=-9/)
  assert.match(af, /,volume=-1dB,/)
})
