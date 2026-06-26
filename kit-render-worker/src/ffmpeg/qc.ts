// @ts-nocheck
/**
 * Delivery QC — ffprobe the rendered output and confirm it matches the profile.
 *
 * Copied comparison core from src/lib/delivery/qc.ts — standalone duplicate
 * intentional so kit-render-worker ships self-contained. This file adds the
 * ffprobe spawn; the comparison logic mirrors the Kit-side module.
 */

import { spawn } from 'child_process'
import type { DeliveryProfile } from '../types'

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

export function videoCodecFamily(key: string): string {
  if (key.startsWith('prores')) return 'prores'
  if (key.startsWith('h264')) return 'h264'
  if (key.startsWith('dnxhr') || key === 'dnxhd') return 'dnxhd'
  return key
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

export function parseProbeJson(json: any): ProbeResult {
  const streams = Array.isArray(json?.streams) ? json.streams : []
  const v = streams.find((s) => s.codec_type === 'video')
  const a = streams.find((s) => s.codec_type === 'audio')
  const fps = v?.r_frame_rate ? evalRatio(v.r_frame_rate) : undefined
  const duration = json?.format?.duration ? Number(json.format.duration) : undefined
  return {
    video: v ? { codec: v.codec_name, width: num(v.width), height: num(v.height), fps } : undefined,
    audio: a ? { codec: a.codec_name, channels: num(a.channels), sample_rate: num(a.sample_rate) } : undefined,
    duration: Number.isFinite(duration) ? duration : undefined,
  }
}

export function compareToProfile(probe: ProbeResult, profile: DeliveryProfile): QCReport {
  const checks: QCCheck[] = []
  const add = (name, expected, actual, pass) =>
    checks.push({ name, expected: String(expected), actual: String(actual ?? '—'), pass })

  add(
    'Resolution',
    `${profile.resolution_w}x${profile.resolution_h}`,
    `${probe.video?.width ?? '?'}x${probe.video?.height ?? '?'}`,
    probe.video?.width === profile.resolution_w && probe.video?.height === profile.resolution_h,
  )
  const expFps = parseFloat(profile.frame_rate)
  const actFps = probe.video?.fps
  add('Frame rate', profile.frame_rate, actFps != null ? actFps.toFixed(3) : '?',
    actFps != null && Number.isFinite(expFps) && Math.abs(actFps - expFps) < 0.05)
  const expVCodec = videoCodecFamily(profile.video_codec)
  add('Video codec', expVCodec, probe.video?.codec, probe.video?.codec === expVCodec)
  add('Audio channels', profile.audio_channels.length, probe.audio?.channels,
    probe.audio?.channels === profile.audio_channels.length)
  add('Audio codec', profile.audio_codec, probe.audio?.codec, probe.audio?.codec === profile.audio_codec)
  if (profile.audio_sample_rate) {
    add('Sample rate', profile.audio_sample_rate, probe.audio?.sample_rate,
      probe.audio?.sample_rate === profile.audio_sample_rate)
  }
  return { checks, pass: checks.every((c) => c.pass) }
}

/** ffprobe the output file and compare it to the profile. */
export async function runQualityControl(opts: {
  ffmpegPath: string
  outputPath: string
  profile: DeliveryProfile
}): Promise<QCReport> {
  const ffprobePath = opts.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  const json = await new Promise<any>((resolve, reject) => {
    const proc = spawn(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', opts.outputPath],
      { windowsHide: true },
    )
    let out = ''
    let err = ''
    proc.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
    proc.stderr.on('data', (c: Buffer) => { err += c.toString('utf8') })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err.slice(0, 300)}`))
      try { resolve(JSON.parse(out)) } catch (e) { reject(e) }
    })
  })
  return compareToProfile(parseProbeJson(json), opts.profile)
}
