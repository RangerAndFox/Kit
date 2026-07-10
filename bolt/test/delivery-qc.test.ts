import { describe, it, expect } from 'vitest'

import {
  parseProbeJson,
  compareToProfile,
  videoCodecFamily,
} from '../../kit-render-worker/src/ffmpeg/qc'

const profile: any = {
  video_codec: 'prores_422_hq',
  resolution_w: 1920,
  resolution_h: 1080,
  frame_rate: '23.976',
  audio_codec: 'pcm_s24le',
  audio_sample_rate: 48000,
  audio_channels: [{ channel: 1 }, { channel: 2 }],
}

const goodProbe = {
  streams: [
    { codec_type: 'video', codec_name: 'prores', width: 1920, height: 1080, r_frame_rate: '24000/1001' },
    { codec_type: 'audio', codec_name: 'pcm_s24le', channels: 2, sample_rate: '48000' },
  ],
  format: { duration: '12.5' },
}

describe('videoCodecFamily', () => {
  it('maps profile keys to ffprobe codec names', () => {
    expect(videoCodecFamily('prores_422_hq')).toBe('prores')
    expect(videoCodecFamily('h264_broadcast')).toBe('h264')
    expect(videoCodecFamily('dnxhr_hq')).toBe('dnxhd')
  })
})

describe('parseProbeJson', () => {
  it('extracts video/audio/duration and evaluates the frame-rate ratio', () => {
    const p = parseProbeJson(goodProbe)
    expect(p.video).toMatchObject({ codec: 'prores', width: 1920, height: 1080 })
    expect(p.video!.fps).toBeCloseTo(23.976, 2)
    expect(p.audio).toMatchObject({ codec: 'pcm_s24le', channels: 2, sample_rate: 48000 })
    expect(p.duration).toBe(12.5)
  })
})

describe('compareToProfile', () => {
  it('passes when the output matches the profile (fps within tolerance)', () => {
    const report = compareToProfile(parseProbeJson(goodProbe), profile)
    expect(report.pass).toBe(true)
    expect(report.checks.every((c) => c.pass)).toBe(true)
  })

  it('flags resolution, codec, and channel mismatches', () => {
    const badProbe = {
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, r_frame_rate: '24000/1001' },
        { codec_type: 'audio', codec_name: 'aac', channels: 1, sample_rate: '44100' },
      ],
      format: { duration: '12.5' },
    }
    const report = compareToProfile(parseProbeJson(badProbe), profile)
    expect(report.pass).toBe(false)
    const failed = report.checks.filter((c) => !c.pass).map((c) => c.name)
    expect(failed).toEqual(
      expect.arrayContaining(['Resolution', 'Video codec', 'Audio channels', 'Audio codec', 'Sample rate']),
    )
  })

  it('flags a frame rate outside tolerance', () => {
    const probe = parseProbeJson({
      streams: [
        { codec_type: 'video', codec_name: 'prores', width: 1920, height: 1080, r_frame_rate: '30/1' },
        { codec_type: 'audio', codec_name: 'pcm_s24le', channels: 2, sample_rate: '48000' },
      ],
      format: {},
    })
    const report = compareToProfile(probe, profile)
    expect(report.checks.find((c) => c.name === 'Frame rate')!.pass).toBe(false)
  })
})
