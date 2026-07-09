/**
 * Delivery QC — confirm a rendered output actually matches its profile.
 *
 * After the worker renders, it ffprobes the output and runs this comparison:
 * resolution, frame rate, video/audio codec family, audio channel count, and
 * sample rate, each within tolerance. The result is posted to the channel as
 * ✅/⚠️ so nothing ships off-spec.
 *
 * This module is the pure decision core (parse + compare, no ffprobe spawn) so
 * it's unit-testable; the worker copy adds the ffprobe invocation.
 */

import type { DeliveryProfile } from './types'

export interface ProbeResult {
  video?: { codec?: string; width?: number; height?: number; fps?: number }
  audio?: { codec?: string; channels?: number; sample_rate?: number }
  duration?: number
}

export interface QCCheck {
  name: string
  expected: string
  actual: string
  pass: boolean
}

export interface QCReport {
  checks: QCCheck[]
  pass: boolean
}

/** Map a profile video-codec key to the codec_name ffprobe reports. */
export function videoCodecFamily(key: string): string {
  if (key.startsWith('prores')) return 'prores'
  if (key.startsWith('h264')) return 'h264'
  if (key.startsWith('dnxhr') || key === 'dnxhd') return 'dnxhd'
  return key
}

/** ffprobe reports pcm_s16le/pcm_s24le/aac directly, so identity is fine. */
export function audioCodecFamily(key: string): string {
  return key
}

/** Parse an ffprobe `-show_streams -show_format -print_format json` blob. */
export function parseProbeJson(json: any): ProbeResult {
  const streams: any[] = Array.isArray(json?.streams) ? json.streams : []
  const v = streams.find((s) => s.codec_type === 'video')
  const a = streams.find((s) => s.codec_type === 'audio')
  const fps = v?.r_frame_rate ? evalRatio(v.r_frame_rate) : undefined
  const duration = json?.format?.duration ? Number(json.format.duration) : undefined
  return {
    video: v
      ? { codec: v.codec_name, width: num(v.width), height: num(v.height), fps }
      : undefined,
    audio: a
      ? { codec: a.codec_name, channels: num(a.channels), sample_rate: num(a.sample_rate) }
      : undefined,
    duration: Number.isFinite(duration) ? duration : undefined,
  }
}

function num(v: any): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function evalRatio(r: string): number | undefined {
  const m = String(r).match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/)
  if (!m) return undefined
  const den = m[2] ? Number(m[2]) : 1
  if (den === 0) return undefined
  return Number(m[1]) / den
}

/** Compare a probed output against the delivery profile it was rendered for. */
export function compareToProfile(probe: ProbeResult, profile: DeliveryProfile): QCReport {
  const checks: QCCheck[] = []
  const add = (name: string, expected: unknown, actual: unknown, pass: boolean) =>
    checks.push({ name, expected: String(expected), actual: String(actual ?? '—'), pass })

  add(
    'Resolution',
    `${profile.resolution_w}x${profile.resolution_h}`,
    `${probe.video?.width ?? '?'}x${probe.video?.height ?? '?'}`,
    probe.video?.width === profile.resolution_w && probe.video?.height === profile.resolution_h,
  )

  const expFps = parseFloat(profile.frame_rate)
  const actFps = probe.video?.fps
  add(
    'Frame rate',
    profile.frame_rate,
    actFps != null ? actFps.toFixed(3) : '?',
    actFps != null && Number.isFinite(expFps) && Math.abs(actFps - expFps) < 0.05,
  )

  const expVCodec = videoCodecFamily(profile.video_codec)
  add('Video codec', expVCodec, probe.video?.codec, probe.video?.codec === expVCodec)

  add(
    'Audio channels',
    profile.audio_channels.length,
    probe.audio?.channels,
    probe.audio?.channels === profile.audio_channels.length,
  )

  const expACodec = audioCodecFamily(profile.audio_codec)
  add('Audio codec', expACodec, probe.audio?.codec, probe.audio?.codec === expACodec)

  if (profile.audio_sample_rate) {
    add(
      'Sample rate',
      profile.audio_sample_rate,
      probe.audio?.sample_rate,
      probe.audio?.sample_rate === profile.audio_sample_rate,
    )
  }

  return { checks, pass: checks.every((c) => c.pass) }
}

/** Render a QC report as Slack mrkdwn lines for the completion message. */
export function formatQCReport(report: QCReport): string {
  const head = report.pass
    ? ':white_check_mark: *QC passed* — output matches the spec.'
    : ':warning: *QC flagged* — output differs from the spec:'
  const lines = report.checks
    .filter((c) => !report.pass) // when passing, the headline is enough
    .map((c) => `${c.pass ? ':white_check_mark:' : ':x:'} ${c.name}: expected ${c.expected}, got ${c.actual}`)
  return report.pass ? head : [head, ...lines].join('\n')
}
