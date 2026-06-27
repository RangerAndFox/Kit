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
  comp: string                // composition name
  frameStart: number          // inclusive
  frameEnd: number            // inclusive
  outputPath: string          // local path incl. [#####] pattern, e.g. D:\...\Comp_[#####].png
  renderSettingsTemplate?: string  // AE Render Settings template (default "Best Settings")
  outputModuleTemplate?: string    // AE Output Module template (empty = comp's RQ default)
}

/**
 * Build the aerender argv for a single chunk. No shell quoting — this array is
 * passed straight to child_process.spawn.
 */
export function buildAerenderArgs(input: AerenderBuildInput): string[] {
  const {
    projectPath,
    comp,
    frameStart,
    frameEnd,
    outputPath,
    renderSettingsTemplate,
    outputModuleTemplate,
  } = input

  if (frameEnd < frameStart) {
    throw new Error(`buildAerenderArgs: frameEnd (${frameEnd}) < frameStart (${frameStart})`)
  }

  const args: string[] = [
    '-project', projectPath,
    '-comp', comp,
    '-s', String(frameStart),
    '-e', String(frameEnd),
    '-RStemplate', renderSettingsTemplate || 'Best Settings',
  ]

  // Output module template is optional — when omitted, aerender uses the
  // template already attached to the comp's render-queue item. Studios that
  // want a guaranteed image-sequence format should define a shared OM template
  // (e.g. "Kit PNG Sequence") and pass its name here.
  if (outputModuleTemplate) {
    args.push('-OMtemplate', outputModuleTemplate)
  }

  args.push(
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
