// @ts-nocheck
/**
 * Read a project's After Effects render queue by scripting AfterFX.exe headless
 * (`-noui -r inspect.jsx`). Standalone duplicate of kit-render-worker's
 * aerender/inspect-script.ts + inspect-runner.ts so this package ships
 * self-contained. Keep in sync with that worker copy.
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

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

function toJsxPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/"/g, '\\"')
}

function buildInspectJsx(projectPath: string, outJsonPath: string): string {
  const proj = toJsxPath(projectPath)
  const out = toJsxPath(outJsonPath)
  return `
(function () {
  function frameOf(seconds, fps) { return Math.round(seconds * fps); }
  var result = { items: [], error: null };
  try {
    app.exitAfterLaunchAndEval = false;
    app.open(new File("${proj}"));
    var rq = app.project.renderQueue;
    for (var i = 1; i <= rq.numItems; i++) {
      var item = rq.item(i);
      if (item.status !== RQItemStatus.QUEUED) continue;
      var comp = item.comp;
      var fps = comp.frameRate;
      var startFrame = frameOf(item.timeSpanStart, fps);
      var durFrames = frameOf(item.timeSpanDuration, fps);
      var outName = "";
      try { var om = item.outputModule(1); if (om && om.file) outName = om.file.name; } catch (e) {}
      result.items.push({
        rqindex: i, comp: comp.name, fps: fps,
        frameStart: startFrame, frameEnd: startFrame + durFrames - 1,
        totalFrames: durFrames, outputName: outName,
        isSequence: /\\[#+\\]/.test(outName) || /#/.test(outName)
      });
    }
  } catch (e) { result.error = e.toString(); }
  var f = new File("${out}");
  f.encoding = "UTF-8"; f.open("w"); f.write(JSON.stringify(result)); f.close();
  app.quit();
})();
`.trim()
}

export async function inspectRenderQueue(
  afterfxPath: string,
  projectPath: string,
  timeoutMs = 180000,
): Promise<{ items: RenderQueueItem[]; error: string | null }> {
  if (!afterfxPath) throw new Error('AFTERFX_PATH not set — the relay needs After Effects to read the render queue')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-deadline-inspect-'))
  const jsxPath = path.join(tmpDir, 'inspect.jsx')
  const outPath = path.join(tmpDir, 'queue.json')
  fs.writeFileSync(jsxPath, buildInspectJsx(projectPath, outPath), 'utf8')

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(afterfxPath, ['-noui', '-r', jsxPath], { windowsHide: true })
    const timer = setTimeout(() => { try { proc.kill() } catch {} ; reject(new Error(`AfterFX inspect timed out after ${timeoutMs}ms`)) }, timeoutMs)
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', () => { clearTimeout(timer); resolve() })
  })

  if (!fs.existsSync(outPath)) throw new Error('AfterFX inspect produced no output — scripting may be blocked or the project failed to open')
  const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'))
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  if (parsed.error) throw new Error(`After Effects: ${parsed.error}`)
  return parsed
}
