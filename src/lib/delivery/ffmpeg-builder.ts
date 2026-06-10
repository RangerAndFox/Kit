/**
 * FFmpeg command builder.
 *
 * Given a delivery profile + naming fields + source files + (optional) loudness
 * measurement, builds the argv array for the second-pass FFmpeg invocation.
 * Also exposes `buildLoudnessAnalysisArgs` for the first pass.
 *
 * Spec: DELIVERY-PIPELINE-SPEC.md, sections "FFmpeg Command Generation" and
 * "Two-Pass Loudness Normalization".
 */

import type { DeliveryProfile, SourceFile, LoudnessMeasurement } from './types'
import { buildChannelMapFilter, requiresAmerge } from './channel-mapper'

interface CodecSpec {
  encoder: string
  flags: string[]
}

export const CODEC_MAP: Record<string, CodecSpec> = {
  prores_422_proxy: { encoder: 'prores_ks', flags: ['-profile:v', '0'] },
  prores_422_lt:    { encoder: 'prores_ks', flags: ['-profile:v', '1'] },
  prores_422:       { encoder: 'prores_ks', flags: ['-profile:v', '2'] },
  prores_422_hq:    { encoder: 'prores_ks', flags: ['-profile:v', '3'] },
  prores_4444:      { encoder: 'prores_ks', flags: ['-profile:v', '4', '-pix_fmt', 'yuva444p10le'] },
  h264:             { encoder: 'libx264',   flags: ['-preset', 'slow', '-crf', '18'] },
  h264_broadcast:   { encoder: 'libx264',   flags: ['-preset', 'slow', '-b:v', '15M', '-maxrate', '15M', '-bufsize', '30M'] },
  dnxhr_lb:         { encoder: 'dnxhd',     flags: ['-profile:v', 'dnxhr_lb'] },
  dnxhr_sq:         { encoder: 'dnxhd',     flags: ['-profile:v', 'dnxhr_sq'] },
  dnxhr_hq:         { encoder: 'dnxhd',     flags: ['-profile:v', 'dnxhr_hq'] },
  dnxhr_hqx:        { encoder: 'dnxhd',     flags: ['-profile:v', 'dnxhr_hqx'] },
  dnxhr_444:        { encoder: 'dnxhd',     flags: ['-profile:v', 'dnxhr_444'] },
}

export const AUDIO_CODEC_MAP: Record<string, CodecSpec> = {
  pcm_s16le: { encoder: 'pcm_s16le', flags: [] },
  pcm_s24le: { encoder: 'pcm_s24le', flags: [] },
  aac:       { encoder: 'aac',       flags: ['-b:a', '192k'] },
}

export interface FFmpegBuildInput {
  profile: DeliveryProfile
  sourceFiles: SourceFile[]
  outputPath: string
  loudness?: LoudnessMeasurement   // pass-1 result; required if profile.lufs_target is set
}

/**
 * Pass 1 — loudness analysis only. No output file.
 * Use the JSON print_format so the result can be parsed with loudness-parser.ts.
 */
export function buildLoudnessAnalysisArgs(profile: DeliveryProfile, primarySource: string): string[] {
  if (profile.lufs_target == null) {
    throw new Error('buildLoudnessAnalysisArgs called on a profile with no lufs_target')
  }
  const lufs = profile.lufs_target
  const tp = profile.true_peak_limit ?? -1
  const lra = profile.lufs_lra ?? 11
  return [
    '-i', primarySource,
    '-af', `loudnorm=I=${lufs}:TP=${tp}:LRA=${lra}:print_format=json`,
    '-f', 'null',
    '-',  // posix; the worker will swap '-' for 'NUL' on Windows when invoking
  ]
}

/**
 * Pass 2 — full transcode. Always builds the complete argv (no shell quoting).
 *
 * If profile.lufs_target is set, `loudness` MUST be provided (the pass-1 measurement).
 * If lufs_target is null, loudnorm is skipped and channel-mapping is the only audio filter.
 */
export function buildFFmpegArgs(input: FFmpegBuildInput): string[] {
  const { profile, sourceFiles, outputPath, loudness } = input
  if (sourceFiles.length === 0) throw new Error('buildFFmpegArgs requires at least one source file')
  if (profile.lufs_target != null && !loudness) {
    throw new Error('Profile has lufs_target but no pass-1 loudness measurement was provided')
  }

  const videoCodec = CODEC_MAP[profile.video_codec]
  if (!videoCodec) throw new Error(`Unknown video codec: ${profile.video_codec}`)

  const audioCodec = AUDIO_CODEC_MAP[profile.audio_codec]
  if (!audioCodec) throw new Error(`Unknown audio codec: ${profile.audio_codec}`)

  const args: string[] = []

  // Inputs (multiple -i pairs)
  for (const src of sourceFiles) {
    args.push('-i', src.path)
  }

  // Video encoder + flags
  args.push('-c:v', videoCodec.encoder)
  args.push(...videoCodec.flags)
  // Override pix_fmt if profile specifies one and codec didn't already set it
  if (profile.pixel_format && !videoCodec.flags.includes('-pix_fmt')) {
    args.push('-pix_fmt', profile.pixel_format)
  }
  // Resolution
  args.push('-s', `${profile.resolution_w}x${profile.resolution_h}`)
  // Frame rate
  args.push('-r', profile.frame_rate)
  // Frame rate mode (cfr enforces constant frame rate)
  if (profile.frame_rate_mode === 'cfr') {
    args.push('-vsync', 'cfr')
  }
  // Color space (passthrough flag if set)
  if (profile.color_space) {
    args.push('-colorspace', profile.color_space)
  }

  // Video bitrate (if specified, for codecs that honor it)
  if (profile.video_bitrate) {
    args.push('-b:v', profile.video_bitrate)
  }

  // Audio encoder + flags
  args.push('-c:a', audioCodec.encoder)
  args.push(...audioCodec.flags)
  args.push('-ar', String(profile.audio_sample_rate))

  if (profile.audio_bitrate) {
    args.push('-b:a', profile.audio_bitrate)
  }

  // External-file audio sources (e.g., "file:mix.wav:L") need an amerge chain
  // built by the worker. v1 doesn't support that path — flag it clearly.
  if (requiresAmerge(profile.audio_channels)) {
    throw new Error(
      'Audio channels reference external files (file:... sources). This profile requires an amerge chain that v1 does not yet build. Use only L/R/FL/FR/FC/LFE/SL/SR/silent sources for now.',
    )
  }

  // Audio filter chain: loudnorm (if applicable) + channel mapping
  const audioFilters: string[] = []
  if (profile.lufs_target != null && loudness) {
    const lufs = profile.lufs_target
    const tp = profile.true_peak_limit ?? -1
    const lra = profile.lufs_lra ?? 11
    audioFilters.push(
      `loudnorm=I=${lufs}:TP=${tp}:LRA=${lra}:` +
        `measured_I=${loudness.input_i}:` +
        `measured_TP=${loudness.input_tp}:` +
        `measured_LRA=${loudness.input_lra}:` +
        `measured_thresh=${loudness.input_thresh}:` +
        `offset=${loudness.target_offset}:linear=true`,
    )
  }
  const channelFilter = buildChannelMapFilter(profile.audio_channels)
  if (channelFilter) audioFilters.push(channelFilter)

  if (audioFilters.length > 0) {
    args.push('-af', audioFilters.join(','))
  }

  // Channel count for the output
  args.push('-ac', String(profile.audio_channels.length))

  // Container-specific tail flags
  if (profile.container === 'mp4') {
    args.push('-movflags', '+faststart')
  } else if (profile.container === 'mov') {
    args.push('-movflags', '+faststart')
  }

  // Output path
  args.push('-y') // overwrite if exists; worker pre-checks should make this safe
  args.push(outputPath)

  return args
}

/**
 * Convert an argv array into a debuggable single-line shell command (for storing
 * in render_jobs.ffmpeg_command). Quotes arguments containing spaces.
 */
export function argsToShellCommand(args: string[], ffmpegBinary = 'ffmpeg'): string {
  const parts = [ffmpegBinary, ...args].map((arg) => {
    if (/\s/.test(arg)) return `"${arg.replace(/"/g, '\\"')}"`
    return arg
  })
  return parts.join(' ')
}
