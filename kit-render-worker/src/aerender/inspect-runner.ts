// @ts-nocheck
/**
 * Run AfterFX.exe headlessly against a generated inspect.jsx and read back the
 * render-queue JSON it writes. Used by the ae_inspect job to discover what the
 * project has queued before any chunks are planned.
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildInspectJsx } from './inspect-script'

export interface RenderQueueItem {
  rqindex: number
  comp: string
  fps: number
  frameStart: number
  frameEnd: number
  totalFrames: number
  outputName: string
  isSequence: boolean
}

export interface InspectResult {
  items: RenderQueueItem[]
  error: string | null
}

/**
 * Script After Effects to dump `projectLocalPath`'s render queue. Returns the
 * parsed items. Throws if AfterFX can't be run or produced no readable output.
 */
export async function inspectRenderQueue(
  afterfxPath: string,
  projectLocalPath: string,
  timeoutMs = 180000,
): Promise<InspectResult> {
  if (!afterfxPath) throw new Error('No AfterFX.exe path configured (set AFTERFX_PATH or AERENDER_PATH)')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-ae-inspect-'))
  const jsxPath = path.join(tmpDir, 'inspect.jsx')
  const outPath = path.join(tmpDir, 'queue.json')
  fs.writeFileSync(jsxPath, buildInspectJsx(projectLocalPath, outPath), 'utf8')

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(afterfxPath, ['-noui', '-r', jsxPath], { windowsHide: true })
    const timer = setTimeout(() => {
      try { proc.kill() } catch {}
      reject(new Error(`AfterFX inspect timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', () => { clearTimeout(timer); resolve() })
  })

  if (!fs.existsSync(outPath)) {
    throw new Error('AfterFX inspect produced no output — scripting may be blocked or the project failed to open')
  }
  const raw = fs.readFileSync(outPath, 'utf8')
  let parsed: InspectResult
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Could not parse render-queue JSON: ${raw.slice(0, 200)}`)
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  if (parsed.error) throw new Error(`After Effects: ${parsed.error}`)
  return parsed
}
