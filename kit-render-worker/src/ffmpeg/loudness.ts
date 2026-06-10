/**
 * Run the pass-1 loudness analysis and parse the resulting JSON.
 *
 * On Windows, replaces the trailing '-' (POSIX null device) with 'NUL'.
 */

import { spawn } from 'child_process'
import { buildLoudnessAnalysisArgs } from './command-builder'
import { parseLoudnessJson } from './loudness-parser'
import type { DeliveryProfile, LoudnessMeasurement } from '../types'

export async function runLoudnessAnalysis(opts: {
  ffmpegPath: string
  profile: DeliveryProfile
  sourcePath: string
}): Promise<LoudnessMeasurement> {
  const args = buildLoudnessAnalysisArgs(opts.profile, opts.sourcePath)
  // Replace the trailing '-' (posix null device) with 'NUL' (Windows null device).
  if (args[args.length - 1] === '-') args[args.length - 1] = 'NUL'

  return new Promise((resolve, reject) => {
    const proc = spawn(opts.ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code !== 0) {
        return reject(new Error(
          `Loudness pass-1 exited ${code}.\n${stderr.split(/\r?\n/).slice(-10).join('\n')}`,
        ))
      }
      try {
        resolve(parseLoudnessJson(stderr))
      } catch (err) {
        reject(err)
      }
    })
  })
}
