import { describe, it, expect } from 'vitest'

import { buildFFmpegArgs } from '../../kit-render-worker/src/ffmpeg/command-builder'

// Minimal profile: stereo, no loudnorm, so we only exercise the mapping logic.
const baseProfile: any = {
  id: 'p',
  name: 'Test',
  video_codec: 'h264',
  audio_codec: 'pcm_s16le',
  resolution_w: 1920,
  resolution_h: 1080,
  frame_rate: '24',
  frame_rate_mode: 'cfr',
  audio_sample_rate: 48000,
  audio_channels: [
    { channel: 1, label: 'L', source: 'L' },
    { channel: 2, label: 'R', source: 'R' },
  ],
  lufs_target: null,
  container: 'mov',
}

function mapsOf(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) if (args[i] === '-map') out.push(args[i + 1])
  return out
}

describe('buildFFmpegArgs stream mapping', () => {
  it('adds explicit -map for a separate audio mix (video in 0, audio in 1)', () => {
    const args = buildFFmpegArgs({
      profile: baseProfile,
      sourceFiles: [
        { path: 'pic.mov', type: 'video', size_bytes: 1 },
        { path: 'mix.wav', type: 'audio', size_bytes: 1 },
      ],
      outputPath: 'out.mov',
    })
    expect(mapsOf(args)).toEqual(['0:v:0', '1:a:0'])
    // Both inputs are present, in order.
    const iArgs = args.reduce<string[]>((a, v, i) => (args[i - 1] === '-i' ? [...a, v] : a), [])
    expect(iArgs).toEqual(['pic.mov', 'mix.wav'])
  })

  it('does not add -map for a single video source (embedded audio)', () => {
    const args = buildFFmpegArgs({
      profile: baseProfile,
      sourceFiles: [{ path: 'pic.mov', type: 'video', size_bytes: 1 }],
      outputPath: 'out.mov',
    })
    expect(mapsOf(args)).toEqual([])
  })
})

function vfOf(args: string[]): string | null {
  const i = args.indexOf('-vf')
  return i >= 0 ? args[i + 1] : null
}

describe('buildFFmpegArgs video filters (upres + 360)', () => {
  it('uses a lanczos scale to the target resolution (no -s)', () => {
    const args = buildFFmpegArgs({
      profile: { ...baseProfile, resolution_w: 3840, resolution_h: 2160 },
      sourceFiles: [{ path: 'pic.mov', type: 'video', size_bytes: 1 }],
      outputPath: 'out.mov',
    })
    expect(args).not.toContain('-s')
    expect(vfOf(args)).toBe('scale=3840:2160:flags=lanczos')
  })

  it('prepends profile.video_filters (e.g. v360) before the scale', () => {
    const args = buildFFmpegArgs({
      profile: { ...baseProfile, video_filters: 'v360=e:c3x2', resolution_w: 4096, resolution_h: 2731 },
      sourceFiles: [{ path: 'pic.mov', type: 'video', size_bytes: 1 }],
      outputPath: 'out.mov',
    })
    expect(vfOf(args)).toBe('v360=e:c3x2,scale=4096:2731:flags=lanczos')
  })
})
