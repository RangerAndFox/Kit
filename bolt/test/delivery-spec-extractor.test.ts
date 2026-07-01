import { describe, it, expect } from 'vitest'

import {
  parseResolution,
  parseFrameRate,
  mapVideoCodec,
  mapAudioCodec,
  parseChannels,
  parseNumber,
  normalizeExtractedSpec,
} from '../src/delivery/spec-extractor'

describe('parseResolution', () => {
  it('parses explicit WxH and shorthand', () => {
    expect(parseResolution('1920x1080')).toEqual({ w: 1920, h: 1080 })
    expect(parseResolution('3840 × 2160')).toEqual({ w: 3840, h: 2160 })
    expect(parseResolution('1080p')).toEqual({ w: 1920, h: 1080 })
    expect(parseResolution('4K')).toEqual({ w: 3840, h: 2160 })
    expect(parseResolution('UHD')).toEqual({ w: 3840, h: 2160 })
    expect(parseResolution('720p')).toEqual({ w: 1280, h: 720 })
  })
  it('returns null when absent/unknown', () => {
    expect(parseResolution(undefined)).toBeNull()
    expect(parseResolution('huge')).toBeNull()
  })
})

describe('parseFrameRate', () => {
  it('pulls the numeric rate', () => {
    expect(parseFrameRate('29.97')).toBe('29.97')
    expect(parseFrameRate('23.976 fps')).toBe('23.976')
    expect(parseFrameRate(24)).toBe('24')
    expect(parseFrameRate(undefined)).toBeNull()
  })
})

describe('mapVideoCodec', () => {
  it('maps human ProRes/H.264/DNxHR names to keys', () => {
    expect(mapVideoCodec('ProRes 422 HQ')).toBe('prores_422_hq')
    expect(mapVideoCodec('ProRes 4444')).toBe('prores_4444')
    expect(mapVideoCodec('Apple ProRes LT')).toBe('prores_422_lt')
    expect(mapVideoCodec('ProRes 422')).toBe('prores_422')
    expect(mapVideoCodec('H.264')).toBe('h264')
    expect(mapVideoCodec('h264 broadcast')).toBe('h264_broadcast')
    expect(mapVideoCodec('DNxHR HQ')).toBe('dnxhr_hq')
    expect(mapVideoCodec('something else')).toBeNull()
  })
})

describe('mapAudioCodec', () => {
  it('maps PCM/AAC variants', () => {
    expect(mapAudioCodec('PCM 24-bit')).toBe('pcm_s24le')
    expect(mapAudioCodec('PCM 16')).toBe('pcm_s16le')
    expect(mapAudioCodec('uncompressed WAV')).toBe('pcm_s24le')
    expect(mapAudioCodec('AAC')).toBe('aac')
    expect(mapAudioCodec(undefined)).toBeNull()
  })
})

describe('parseChannels', () => {
  it('maps named + numeric layouts', () => {
    expect(parseChannels('stereo')).toHaveLength(2)
    expect(parseChannels('mono')).toHaveLength(1)
    expect(parseChannels('5.1')).toHaveLength(6)
    expect(parseChannels(2)).toHaveLength(2)
    expect(parseChannels('8 channels')).toHaveLength(8)
    expect(parseChannels(undefined)).toBeNull()
  })
})

describe('parseNumber', () => {
  it('extracts signed/decimal numbers from strings', () => {
    expect(parseNumber('-24 LUFS')).toBe(-24)
    expect(parseNumber('-2 dBTP')).toBe(-2)
    expect(parseNumber(48000)).toBe(48000)
    expect(parseNumber('n/a')).toBeNull()
  })
})

describe('normalizeExtractedSpec', () => {
  it('coerces a full event spec into DeliveryProfile fields', () => {
    const { spec, missing } = normalizeExtractedSpec({
      name: 'Ignite 2026 Session',
      video_codec: 'ProRes 422 HQ',
      resolution: '1920x1080',
      frame_rate: '29.97',
      audio_codec: 'PCM 24-bit',
      audio_channels: 'stereo',
      audio_sample_rate: 48000,
      lufs_target: -24,
      true_peak_limit: -2,
      container: 'MOV',
    })
    expect(missing).toEqual([])
    expect(spec).toMatchObject({
      name: 'Ignite 2026 Session',
      video_codec: 'prores_422_hq',
      resolution_w: 1920,
      resolution_h: 1080,
      frame_rate: '29.97',
      audio_codec: 'pcm_s24le',
      audio_sample_rate: 48000,
      lufs_target: -24,
      true_peak_limit: -2,
      container: 'mov',
    })
    expect(spec.audio_channels).toHaveLength(2)
  })

  it('flags missing required fields and warns on defaulted audio/loudness', () => {
    const { spec, missing, warnings } = normalizeExtractedSpec({ name: 'Sparse' })
    expect(missing).toEqual(expect.arrayContaining(['resolution', 'frame_rate', 'video_codec']))
    // Defaults still produce a renderable spec.
    expect(spec.resolution_w).toBe(1920)
    expect(spec.audio_codec).toBe('pcm_s24le')
    expect(spec.lufs_target).toBeNull()
    expect(warnings.join(' ')).toMatch(/loudness/i)
  })

  it('accepts pre-split resolution_w/resolution_h', () => {
    const { spec } = normalizeExtractedSpec({ resolution_w: 3840, resolution_h: 2160, video_codec: 'H.264', frame_rate: '25' })
    expect(spec.resolution_w).toBe(3840)
    expect(spec.resolution_h).toBe(2160)
  })

  it('passes through video_filters for 360 / unique formats (else null)', () => {
    expect(normalizeExtractedSpec({ video_filters: 'v360=e:c3x2' }).spec.video_filters).toBe('v360=e:c3x2')
    expect(normalizeExtractedSpec({ name: 'plain' }).spec.video_filters).toBeNull()
  })
})
