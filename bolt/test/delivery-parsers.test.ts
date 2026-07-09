import { describe, it, expect } from 'vitest'

import { parseFFmpegProgress } from '../../src/lib/delivery/progress-parser'
import { parseLoudnessJson } from '../../src/lib/delivery/loudness-parser'

describe('parseFFmpegProgress', () => {
  const line =
    'frame= 1234 fps= 45 q=2.0 size=  102400kB time=00:00:50.00 bitrate=20345.6kbits/s speed=2x'

  it('extracts current time and percent against the source duration', () => {
    const p = parseFFmpegProgress(line, 100)!
    expect(p.current_seconds).toBe(50)
    expect(p.percent).toBe(50)
    expect(p.raw_fps).toBe(45)
  })

  it('computes ETA from FFmpeg speed: remaining content / speed', () => {
    // 50s left of content at 2x realtime → ~25s wall. (The old fps-based
    // formula returned a nonsensical ~4s here.)
    const p = parseFFmpegProgress(line, 100)!
    expect(p.eta_seconds).toBe(25)
  })

  it('ETA is null when no speed= is present', () => {
    const noSpeed = 'frame=10 fps=20 time=00:00:10.00 bitrate=1kbits/s'
    expect(parseFFmpegProgress(noSpeed, 100)!.eta_seconds).toBeNull()
  })

  it('ETA scales correctly at slower-than-realtime speed', () => {
    // 90s left at 0.5x → 180s wall.
    const slow = 'frame=1 fps=1 time=00:00:10.00 bitrate=1kbits/s speed=0.5x'
    expect(parseFFmpegProgress(slow, 100)!.eta_seconds).toBe(180)
  })

  it('returns null for a line with no time=', () => {
    expect(parseFFmpegProgress('Press [q] to stop', 100)).toBeNull()
  })
})

describe('parseLoudnessJson', () => {
  const block = `{
\t"input_i" : "-27.05",
\t"input_tp" : "-12.71",
\t"input_lra" : "7.80",
\t"input_thresh" : "-37.47",
\t"output_i" : "-23.01",
\t"output_tp" : "-2.00",
\t"output_lra" : "7.60",
\t"output_thresh" : "-33.45",
\t"normalization_type" : "dynamic",
\t"target_offset" : "0.01"
}`

  it('parses the loudnorm JSON block into numbers', () => {
    const m = parseLoudnessJson(`[Parsed_loudnorm_0 @ 0x55d] \n${block}\n`)
    expect(m).toEqual({
      input_i: -27.05,
      input_tp: -12.71,
      input_lra: 7.8,
      input_thresh: -37.47,
      target_offset: 0.01,
    })
  })

  it('ignores earlier braces in stderr (filtergraph/config noise)', () => {
    // A leading `{...}` that is NOT the loudnorm block must not poison parsing.
    const noisy = `Stream mapping {something weird}\n[config] { not json }\n${block}`
    const m = parseLoudnessJson(noisy)
    expect(m.input_i).toBe(-27.05)
    expect(m.target_offset).toBe(0.01)
  })

  it('throws when no loudnorm block is present', () => {
    expect(() => parseLoudnessJson('no json here at all')).toThrow(/No loudnorm JSON/)
  })
})
