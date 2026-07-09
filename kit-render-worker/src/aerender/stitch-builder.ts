// @ts-nocheck
/**
 * Stitch builder — turns the rendered image sequence into a single movie with
 * FFmpeg. This is the join step after all aerender chunks complete.
 *
 * AE writes silent image sequences (e.g. Comp_00000.png), so the stitch is
 * video-only. If a delivery profile is attached, its video codec / resolution /
 * pixel format are applied here; otherwise we default to ProRes 422 — and the
 * resulting movie can still be sent through the delivery pipeline afterwards for
 * full broadcast spec (audio, loudness, naming).
 *
 * Spec: AE-RENDER-FARM-SPEC.md, "Stitch step".
 */

import { CODEC_MAP } from '../ffmpeg/command-builder'

export interface StitchBuildInput {
  sequencePattern: string   // FFmpeg-style pattern, e.g. "D:\...\Comp_%05d.png"
  startNumber: number       // first frame number in the sequence
  frameRate: string         // comp fps, e.g. "59.94"
  outputPath: string
  videoCodec?: string       // delivery_profiles.video_codec key; default prores_422
  resolutionW?: number | null
  resolutionH?: number | null
  pixelFormat?: string | null
}

/**
 * Build the FFmpeg argv that encodes the image sequence into one movie.
 */
export function buildStitchArgs(input: StitchBuildInput): string[] {
  const codecKey = input.videoCodec || 'prores_422'
  const codec = CODEC_MAP[codecKey]
  if (!codec) throw new Error(`buildStitchArgs: unknown video codec ${codecKey}`)

  const args: string[] = [
    '-framerate', input.frameRate,
    '-start_number', String(input.startNumber),
    '-i', input.sequencePattern,
    '-c:v', codec.encoder,
    ...codec.flags,
  ]

  if (input.pixelFormat && !codec.flags.includes('-pix_fmt')) {
    args.push('-pix_fmt', input.pixelFormat)
  }
  if (input.resolutionW && input.resolutionH) {
    args.push('-s', `${input.resolutionW}x${input.resolutionH}`)
  }
  // Constant output frame rate matching the comp.
  args.push('-r', input.frameRate)
  args.push('-y', input.outputPath)

  return args
}
