// @ts-nocheck
/**
 * Audio pass — image sequences carry no audio, so the prepare script queued a
 * WAV duplicate of each audible comp in the farm copy. The relay renders that
 * duplicate LOCALLY with aerender (audio can't be frame-split, and the pass is
 * fast) and the assemble step muxes the result.
 *
 * aerender lives next to AfterFX.exe; derived unless AERENDER_PATH is set.
 */

import { spawn } from 'child_process'
import { config } from './config'

function aerenderPath(): string {
  if (config.aerenderPath) return config.aerenderPath
  return config.afterfxPath.replace(/AfterFX\.exe$/i, 'aerender.exe')
}

export async function renderAudioWav(
  farmProjectPath: string,
  audioRqindex: number,
  outputWavPath: string,
  timeoutMs = 1800000,
): Promise<void> {
  const args = [
    '-project', farmProjectPath,
    '-rqindex', String(audioRqindex),
    '-output', outputWavPath,
    '-continueOnMissingFootage',
    '-sound', 'OFF',
  ]
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(aerenderPath(), args, { windowsHide: true })
    let tail = ''
    const timer = setTimeout(() => { try { proc.kill() } catch {} ; reject(new Error('aerender audio pass timed out')) }, timeoutMs)
    const onChunk = (c) => { tail = (tail + c.toString('utf8')).slice(-8192) }
    proc.stdout.on('data', onChunk)
    proc.stderr.on('data', onChunk)
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`aerender audio pass exited ${code}: ${tail.split(/\r?\n/).slice(-6).join(' | ')}`))
    })
  })
}
