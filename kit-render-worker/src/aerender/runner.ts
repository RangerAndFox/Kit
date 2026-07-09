// @ts-nocheck
/**
 * Spawn aerender as a child process for one chunk. aerender writes progress to
 * stdout (unlike FFmpeg, which uses stderr), so we parse stdout and debounce
 * onProgress to every 2 seconds. Returns { exitCode, output } when it exits.
 */

import { spawn } from 'child_process'
import { parseAerenderProgress } from './progress-parser'

const OUTPUT_TAIL_BYTES = 64 * 1024 // keep only the last lines for diagnostics

export interface AeRunOptions {
  aerenderPath: string
  args: string[]
  frameStart: number
  frameEnd: number
  onProgress?: (info: { percent: number; current_frame: number }) => void
}

export interface AeRunResult {
  exitCode: number
  output: string   // combined stdout+stderr tail
}

export async function runAerender(opts: AeRunOptions): Promise<AeRunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(opts.aerenderPath, opts.args, { windowsHide: true })
    let buffer = ''
    let lastEmitTs = 0

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      buffer = (buffer + text).slice(-OUTPUT_TAIL_BYTES)

      const now = Date.now()
      if (now - lastEmitTs >= 2000 && opts.onProgress) {
        const lines = text.split(/\r|\n/).reverse()
        for (const line of lines) {
          const prog = parseAerenderProgress(line, opts.frameStart, opts.frameEnd)
          if (prog) {
            opts.onProgress({ percent: prog.percent, current_frame: prog.current_frame })
            lastEmitTs = now
            break
          }
        }
      }
    }

    // aerender prints PROGRESS to stdout; errors land on stderr. Watch both.
    proc.stdout.on('data', onChunk)
    proc.stderr.on('data', onChunk)

    proc.on('error', reject)
    proc.on('exit', (code) => {
      resolve({ exitCode: code ?? -1, output: buffer })
    })
  })
}
