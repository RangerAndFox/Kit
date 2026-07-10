// @ts-nocheck
/**
 * Assemble step — after Deadline finishes a comp's PNG sequence, encode it to
 * the artist's original output-module format (sniffed from the OM settings the
 * prepare script captured), mux the WAV audio pass if one exists, at the comp's
 * frame rate. The final file lands in the comp's render folder with the
 * artist's original output filename; the frames are deleted on success unless
 * AE_KEEP_FRAMES=true.
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { config } from './config'

interface TargetFormat {
  videoArgs: string[]
  audioArgs: string[]   // used only when a WAV exists
  ext: string           // container extension, with dot
  label: string
}

/**
 * Sniff the deliverable format from the OM settings blob + original filename.
 * The blob is AE's getSettings() JSON — codec names appear as human-readable
 * strings ("Apple ProRes 422 HQ", "H.264", ...). Defaults to ProRes 422 .mov.
 */
export function sniffTargetFormat(outputSettingsRaw: string, originalName: string): TargetFormat {
  const raw = (outputSettingsRaw || '').toLowerCase()
  const ext = (path.extname(originalName || '') || '.mov').toLowerCase()

  const prores = (profile: string, label: string): TargetFormat => ({
    videoArgs: ['-c:v', 'prores_ks', '-profile:v', profile, '-pix_fmt', 'yuv422p10le'],
    audioArgs: ['-c:a', 'pcm_s24le'],
    ext: '.mov',
    label,
  })

  if (raw.includes('prores 4444')) return { ...prores('4', 'ProRes 4444'), videoArgs: ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le'] }
  if (raw.includes('prores 422 hq')) return prores('3', 'ProRes 422 HQ')
  if (raw.includes('prores 422 lt')) return prores('1', 'ProRes 422 LT')
  if (raw.includes('prores 422 proxy')) return prores('0', 'ProRes 422 Proxy')
  if (raw.includes('prores 422')) return prores('2', 'ProRes 422')

  if (raw.includes('h.264') || raw.includes('h264') || ext === '.mp4') {
    return {
      videoArgs: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p'],
      audioArgs: ['-c:a', 'aac', '-b:a', '320k'],
      ext: '.mp4',
      label: 'H.264',
    }
  }

  // Unknown format (or the settings blob was unreadable): ProRes 422 in .mov is
  // the studio-safe default.
  return prores('2', 'ProRes 422 (default)')
}

export interface AssembleInput {
  framesDir: string        // folder containing the PNG sequence
  framePattern: string     // e.g. "MainComp_%05d.png"
  startNumber: number
  fps: number
  audioWavPath?: string | null
  outputPath: string       // final deliverable path (ext decides container)
  target: TargetFormat
}

export function buildAssembleArgs(a: AssembleInput): string[] {
  const args: string[] = [
    '-framerate', String(a.fps),
    '-start_number', String(a.startNumber),
    '-i', path.join(a.framesDir, a.framePattern),
  ]
  if (a.audioWavPath) args.push('-i', a.audioWavPath)

  args.push(...a.target.videoArgs)
  if (a.audioWavPath) {
    args.push(...a.target.audioArgs)
    // Audio pass duration can differ from the sequence by a frame — end at the
    // shorter of the two so the deliverable never freezes on the last frame.
    args.push('-shortest')
  }
  args.push('-r', String(a.fps))
  args.push('-y', a.outputPath)
  return args
}

export async function runFfmpeg(args: string[], timeoutMs = 3600000): Promise<{ exitCode: number; tail: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, args, { windowsHide: true })
    let tail = ''
    const timer = setTimeout(() => { try { proc.kill() } catch {} ; reject(new Error('ffmpeg assemble timed out')) }, timeoutMs)
    proc.stderr.on('data', (c) => { tail = (tail + c.toString('utf8')).slice(-8192) })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, tail }) })
  })
}

/**
 * Assemble one comp: frames (+audio) → deliverable. Returns the final path.
 * Deletes the frames dir on success unless AE_KEEP_FRAMES=true.
 */
export async function assembleComp(job: {
  frames_dir: string
  frame_pattern: string
  frame_start: number
  fps: number
  audio_wav: string | null
  output_dir: string
  original_output_name: string
  output_settings_raw: string
}): Promise<string> {
  const target = sniffTargetFormat(job.output_settings_raw, job.original_output_name)

  // Keep the artist's filename; force the container extension the codec needs.
  const base = (job.original_output_name || 'render').replace(/\.[^.]+$/, '') || 'render'
  const outputPath = path.join(job.output_dir, `${base}${target.ext}`)

  const audioExists = job.audio_wav && fs.existsSync(job.audio_wav)
  const args = buildAssembleArgs({
    framesDir: job.frames_dir,
    framePattern: job.frame_pattern,
    startNumber: job.frame_start,
    fps: job.fps,
    audioWavPath: audioExists ? job.audio_wav : null,
    outputPath,
    target,
  })

  console.log(`[assemble] ${base}: ${target.label}${audioExists ? ' + audio' : ''} @ ${job.fps}fps`)
  const res = await runFfmpeg(args)
  if (res.exitCode !== 0) {
    try { fs.unlinkSync(outputPath) } catch {}
    throw new Error(`ffmpeg assemble exited ${res.exitCode}: ${res.tail.split(/\r?\n/).slice(-6).join(' | ')}`)
  }

  if (!config.keepFrames) {
    try { fs.rmSync(job.frames_dir, { recursive: true, force: true }) } catch {}
    if (audioExists) { try { fs.unlinkSync(job.audio_wav) } catch {} }
  }
  return outputPath
}
