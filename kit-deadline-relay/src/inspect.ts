// @ts-nocheck
/**
 * Prepare a project for the farm by scripting AfterFX.exe headless.
 *
 * Deadline frame-splits only image sequences, but artists queue their comps
 * with the REAL deliverable output module (e.g. ProRes 422 .mov). So for each
 * QUEUED render-queue item this script:
 *
 *   1. Records the item's original output module — filename, and the raw
 *      getSettings() blob (the relay sniffs the codec out of it: ProRes 422,
 *      H.264, ...). That's the assemble target.
 *   2. Overrides the item's OM to a PNG sequence so the farm can frame-split.
 *   3. If the comp has audio, duplicates the item and sets the duplicate's OM
 *      to WAV — the relay renders that duplicate locally (audio can't be
 *      frame-split) and muxes it in at assemble time.
 *   4. Saves a farm copy next to the original: <name>__kitfarm.aep. Deadline
 *      nodes render the farm copy; the artist's file is never modified.
 *
 * aerender's -comp flag renders the FIRST queued instance of a comp already in
 * the render queue, so the audio duplicate (added after) is never picked up by
 * the Deadline video job.
 */

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface PreparedItem {
  rqindex: number
  comp: string
  fps: number
  frameStart: number
  frameEnd: number
  totalFrames: number
  originalOutputName: string   // e.g. "MainComp.mov" — the deliverable filename
  outputSettingsRaw: string    // JSON blob of om.getSettings() for codec sniffing
  sequenceOk: boolean          // OM override to PNG sequence succeeded
  hasAudio: boolean
  audioRqindex: number | null  // rqindex of the WAV duplicate (relay renders locally)
}

export interface PrepareResult {
  items: PreparedItem[]
  farmProjectPath: string      // the saved __kitfarm.aep
  error: string | null
}

function toJsxPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/"/g, '\\"')
}

function buildPrepareJsx(projectPath: string, farmCopyPath: string, outJsonPath: string): string {
  const proj = toJsxPath(projectPath)
  const farmCopy = toJsxPath(farmCopyPath)
  const out = toJsxPath(outJsonPath)
  return `
(function () {
  function frameOf(seconds, fps) { return Math.round(seconds * fps); }
  var result = { items: [], farmProjectPath: "${farmCopy}", error: null };
  try {
    app.exitAfterLaunchAndEval = false;
    app.open(new File("${proj}"));
    var rq = app.project.renderQueue;
    var originals = [];
    for (var i = 1; i <= rq.numItems; i++) {
      if (rq.item(i).status === RQItemStatus.QUEUED) originals.push(i);
    }
    for (var k = 0; k < originals.length; k++) {
      var idx = originals[k];
      var item = rq.item(idx);
      var comp = item.comp;
      var fps = comp.frameRate;
      var startFrame = frameOf(item.timeSpanStart, fps);
      var durFrames = frameOf(item.timeSpanDuration, fps);

      var om = item.outputModule(1);
      var originalName = "";
      try { if (om.file) originalName = om.file.name; } catch (e) {}
      var settingsRaw = "";
      try { settingsRaw = JSON.stringify(om.getSettings(GetSettingsFormat.STRING)); } catch (e) {}

      // Audio present? Any layer with active audio.
      var hasAudio = false;
      try {
        for (var L = 1; L <= comp.numLayers; L++) {
          var lyr = comp.layer(L);
          if (lyr.hasAudio && lyr.audioEnabled) { hasAudio = true; break; }
        }
      } catch (e) {}

      // Override the video OM to a PNG sequence so the farm can frame-split.
      var sequenceOk = false;
      try { om.setSettings({ "Format": "PNG Sequence" }); sequenceOk = true; } catch (e1) {
        try { om.applyTemplate("PNG Sequence"); sequenceOk = true; } catch (e2) {
          try { om.applyTemplate("Multi-Machine Sequence"); sequenceOk = true; } catch (e3) {}
        }
      }

      // Audio pass: duplicate the item, set its OM to WAV. Rendered locally by
      // the relay (audio can't be frame-split across machines).
      var audioIdx = null;
      if (hasAudio) {
        try {
          var dup = item.duplicate();
          audioIdx = rq.numItems; // duplicates land at the end of the queue
          var dupOm = rq.item(audioIdx).outputModule(1);
          var audioOk = false;
          try { dupOm.setSettings({ "Format": "WAV" }); audioOk = true; } catch (a1) {
            try { dupOm.applyTemplate("AIFF 48kHz"); audioOk = true; } catch (a2) {}
          }
          if (!audioOk) { try { rq.item(audioIdx).remove(); } catch (r) {} audioIdx = null; }
        } catch (eDup) { audioIdx = null; }
      }

      result.items.push({
        rqindex: idx, comp: comp.name, fps: fps,
        frameStart: startFrame, frameEnd: startFrame + durFrames - 1,
        totalFrames: durFrames,
        originalOutputName: originalName,
        outputSettingsRaw: settingsRaw,
        sequenceOk: sequenceOk,
        hasAudio: hasAudio,
        audioRqindex: audioIdx
      });
    }
    if (result.items.length > 0) {
      app.project.save(new File("${farmCopy}"));
    }
  } catch (e) { result.error = e.toString(); }
  var f = new File("${out}");
  f.encoding = "UTF-8"; f.open("w"); f.write(JSON.stringify(result)); f.close();
  app.quit();
})();
`.trim()
}

/**
 * Run the prepare script against `projectPath` (a farm/UNC path). Writes the
 * farm copy next to the original as `<basename>__kitfarm.aep`.
 */
export async function prepareProject(
  afterfxPath: string,
  projectPath: string,
  timeoutMs = 300000,
): Promise<PrepareResult> {
  if (!afterfxPath) throw new Error('AFTERFX_PATH not set — the relay needs After Effects to read the render queue')

  const farmCopyPath = projectPath.replace(/\.aep$/i, '__kitfarm.aep')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-deadline-prepare-'))
  const jsxPath = path.join(tmpDir, 'prepare.jsx')
  const outPath = path.join(tmpDir, 'result.json')
  fs.writeFileSync(jsxPath, buildPrepareJsx(projectPath, farmCopyPath, outPath), 'utf8')

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(afterfxPath, ['-noui', '-r', jsxPath], { windowsHide: true })
    const timer = setTimeout(() => { try { proc.kill() } catch {} ; reject(new Error(`AfterFX prepare timed out after ${timeoutMs}ms`)) }, timeoutMs)
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', () => { clearTimeout(timer); resolve() })
  })

  if (!fs.existsSync(outPath)) {
    throw new Error('AfterFX prepare produced no output — scripting may be blocked or the project failed to open')
  }
  const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'))
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  if (parsed.error) throw new Error(`After Effects: ${parsed.error}`)
  return parsed
}
