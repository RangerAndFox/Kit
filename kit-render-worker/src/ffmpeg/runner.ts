// @ts-nocheck
/**
 * Spawn FFmpeg as a child process. Stream stderr through the progress parser
 * and call `onProgress` periodically (debounced to every 2 seconds).
 *
 * Returns { exitCode, stderr } when the process exits.
 */

import { spawn } from 'child_process'
import { parseFFmpegProgress } from './progress-parser'

const STDERR_TAIL_BYTES = 64 * 1024 // 64KB — only the last lines matter for diagnostics

export interface RunOptions {
  ffmpegPath: string
  args: string[]
  totalDurationSeconds: number
  onProgress?: (info: { percent: number; eta_seconds: number | null; current_seconds: number }) => void
}

export interface RunResult {
  exitCode: number
  stderr: string
}

export async function runFFmpeg(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(opts.ffmpegPath, opts.args, { windowsHide: true })
    let stderrBuffer = ''
    let lastProgressEmitTs = 0

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderrBuffer = (stderrBuffer + text).slice(-STDERR_TAIL_BYTES)

      const now = Date.now()
      if (now - lastProgressEmitTs >= 2000 && opts.onProgress) {
        // Try to parse the last line containing time= for progress
        const lines = text.split(/\r|\n/).reverse()
        for (const line of lines) {
          const prog = parseFFmpegProgress(line, opts.totalDurationSeconds)
          if (prog) {
            opts.onProgress({
              percent: prog.percent,
              eta_seconds: prog.eta_seconds,
              current_seconds: prog.current_seconds,
            })
            lastProgressEmitTs = now
            break
          }
        }
      }
    })

    proc.on('error', reject)
    proc.on('exit', (code) => {
      resolve({ exitCode: code ?? -1, stderr: stderrBuffer })
    })
  })
}

/**
 * Read source video duration in seconds via ffprobe. Falls back to 0 if it
 * can't determine duration (caller can default progress to "indeterminate").
 */
export async function probeDurationSeconds(ffmpegPath: string, sourcePath: string): Promise<number> {
  // ffmpegPath might be "ffmpeg" — ffprobe lives next to it. Try replacing.
  const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1')
  return new Promise((resolve) => {
    const proc = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      sourcePath,
    ], { windowsHide: true })
    let out = ''
    proc.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
    proc.on('exit', () => {
      const n = Number(out.trim())
      resolve(Number.isFinite(n) ? n : 0)
    })
    proc.on('error', () => resolve(0))
  })
}
