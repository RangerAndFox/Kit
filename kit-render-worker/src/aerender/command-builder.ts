// @ts-nocheck
/**
 * aerender command builder.
 *
 * Builds the argv for Adobe's headless renderer (aerender.exe) to render ONE
 * frame range of a composition to an image sequence. Every chunk of a render
 * request shares the same -project / -comp / -output pattern and differs only
 * in -s (start frame) and -e (end frame), so the chunks write non-overlapping
 * frame-numbered files into the same output folder and never collide.
 *
 * Spec: AE-RENDER-FARM-SPEC.md, "aerender command".
 *
 * aerender docs: the -s/-e flags accept frame numbers (relative to the comp's
 * start frame). -RStemplate / -OMtemplate reference named templates that must
 * exist in each machine's After Effects preferences.
 */

export interface AerenderBuildInput {
  projectPath: string         // local path to the .aep
  frameStart: number          // inclusive
  frameEnd: number            // inclusive
  outputPath: string          // local path incl. [#####] pattern, e.g. D:\...\Comp_[#####].png

  // Render-queue-driven mode (preferred): point at an existing render-queue item
  // by its AE index. Its render settings + output module (format) are reused;
  // -output just redirects where the frames land.
  rqindex?: number

  // Explicit mode (programmatic): render a comp by name with templates.
  comp?: string
  renderSettingsTemplate?: string  // AE Render Settings template (default "Best Settings")
  outputModuleTemplate?: string    // AE Output Module template (empty = comp's RQ default)
}

/**
 * Build the aerender argv for a single chunk. No shell quoting — this array is
 * passed straight to child_process.spawn.
 */
export function buildAerenderArgs(input: AerenderBuildInput): string[] {
  const { projectPath, frameStart, frameEnd, outputPath, rqindex, comp } = input

  if (frameEnd < frameStart) {
    throw new Error(`buildAerenderArgs: frameEnd (${frameEnd}) < frameStart (${frameStart})`)
  }
  if (rqindex == null && !comp) {
    throw new Error('buildAerenderArgs: provide either rqindex (RQ-driven) or comp (explicit)')
  }

  const args: string[] = ['-project', projectPath]

  if (rqindex != null) {
    // Reuse the queue item's own render settings + output module.
    args.push('-rqindex', String(rqindex))
  } else {
    args.push('-comp', comp!)
    args.push('-RStemplate', input.renderSettingsTemplate || 'Best Settings')
    // Output module template is optional — when omitted, aerender uses the
    // template already attached to the comp's render-queue item.
    if (input.outputModuleTemplate) {
      args.push('-OMtemplate', input.outputModuleTemplate)
    }
  }

  args.push(
    '-s', String(frameStart),
    '-e', String(frameEnd),
    // -output redirects the destination (keeping the OM's format) so chunks from
    // every machine land in the same shared Dropbox folder.
    '-output', outputPath,
    // Keep render-farm nodes from blocking on a dialog: skip missing footage
    // rather than halting, and never play the completion sound.
    '-continueOnMissingFootage',
    '-sound', 'OFF',
    // Use the host's multi-frame rendering / all cores for the chunk.
    '-mp',
  )

  return args
}

/**
 * Debuggable single-line command for storing in render_jobs.aerender_command.
 */
export function aerenderArgsToShellCommand(args: string[], aerenderBinary = 'aerender'): string {
  return [aerenderBinary, ...args]
    .map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ')
}
