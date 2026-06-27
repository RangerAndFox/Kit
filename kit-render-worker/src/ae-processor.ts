// @ts-nocheck
/**
 * After Effects job processors.
 *
 *   processAeInspect — script AfterFX to read the project's render queue, then
 *                      fan the queued items out into ae_chunk rows.
 *   processAeChunk   — render one frame range (via aerender -rqindex) to the
 *                      shared output folder, then try to finalize the parent.
 *   processAeStitch  — encode the completed image sequence into one movie with
 *                      FFmpeg, then mark the parent render complete.
 *
 * Finalize lock: when a chunk finishes it checks whether every sibling chunk is
 * complete. If so it atomically claims the parent's `claimed_by` sentinel
 * ('FINALIZED') — only one worker wins that UPDATE — and the winner enqueues the
 * single ae_stitch job. This avoids a Postgres function while staying race-safe.
 *
 * Spec: AE-RENDER-FARM-SPEC.md.
 */

import * as path from 'path'
import * as fs from 'fs'
import { supabase } from './supabase'
import { config } from './config'
import { setCurrentJob } from './heartbeat'
import type { ClaimedJob } from './job-claimer'
import { resolveDropboxPath, resolveDropboxDir, ensureOutputDir } from './dropbox/file-resolver'
import { buildAerenderArgs, aerenderArgsToShellCommand } from './aerender/command-builder'
import { runAerender } from './aerender/runner'
import { buildStitchArgs } from './aerender/stitch-builder'
import { inspectRenderQueue } from './aerender/inspect-runner'
import { runFFmpeg } from './ffmpeg/runner'

const FINALIZE_SENTINEL = 'FINALIZED'

/** Split [start..start+total-1] into `count` near-even contiguous ranges. */
function planChunks(total: number, count: number, start = 0) {
  const n = Math.max(1, Math.min(Math.floor(count) || 1, total))
  const base = Math.floor(total / n)
  const rem = total % n
  const chunks: { index: number; frameStart: number; frameEnd: number }[] = []
  let cursor = start
  for (let i = 0; i < n; i++) {
    const size = base + (i < rem ? 1 : 0)
    chunks.push({ index: i, frameStart: cursor, frameEnd: cursor + size - 1 })
    cursor += size
  }
  return chunks
}

// ─── AE inspect: read the project's render queue, fan out chunks ─────────────

export async function processAeInspect(job: ClaimedJob): Promise<void> {
  setCurrentJob(job.id)
  try {
    await update(job.id, { status: 'processing', progress_message: 'Reading After Effects render queue...' })

    if (!config.afterfxPath) throw new Error('ae_inspect claimed but no AfterFX path configured')
    if (!job.ae_project_path) throw new Error('ae_inspect has no ae_project_path')

    const project = resolveDropboxPath(job.ae_project_path)
    if (!project) {
      throw new Error(
        `Project not found locally: ${job.ae_project_path}. Ensure Dropbox has synced it under DROPBOX_SYNC_PATH=${config.dropboxSyncPath}.`,
      )
    }

    const queue = await inspectRenderQueue(config.afterfxPath, project.localPath)
    if (!queue.items.length) {
      throw new Error('No QUEUED items in the project render queue. Queue at least one item in After Effects and re-submit.')
    }

    // How many AE-capable workers can share the load right now?
    const { count: aeWorkers } = await supabase
      .from('render_workers')
      .select('hostname', { count: 'exact', head: true })
      .eq('ae_capable', true)
      .eq('status', 'online')
    const workerCount = Math.max(1, aeWorkers || 1)

    const projectDir = dropboxDirname(job.ae_project_path)
    const chunkRows: any[] = []
    let totalFrames = 0

    for (const item of queue.items) {
      totalFrames += item.totalFrames
      const safeComp = sanitizeName(item.comp)
      // Redirect output into a shared Dropbox folder next to the project so all
      // machines' frames collect in one place (the project's own absolute output
      // path can't resolve across nodes). Keep the project's output filename.
      const outDir = `${projectDir}/render/${safeComp}`
      const outName = item.outputName || (item.isSequence ? `${safeComp}_[#####].png` : `${safeComp}.mov`)

      // Image sequences frame-split across machines; single-movie outputs can't
      // be split, so they render whole on one machine.
      const splits = item.isSequence
        ? planChunks(item.totalFrames, workerCount, item.frameStart)
        : [{ index: 0, frameStart: item.frameStart, frameEnd: item.frameEnd }]

      splits.forEach((c, _idx) => {
        chunkRows.push({
          job_type: 'ae_chunk',
          status: 'pending',
          parent_job_id: job.parent_job_id,
          chunk_index: chunkRows.length,
          frame_start: c.frameStart,
          frame_end: c.frameEnd,
          total_frames: item.totalFrames,
          frame_rate: String(item.fps),
          requested_by: job.requested_by ?? 'system',
          slack_channel: job.slack_channel,
          slack_thread_ts: job.slack_thread_ts,
          source_files: [{ path: job.ae_project_path, type: 'video', size_bytes: 0 }],
          ae_project_path: job.ae_project_path,
          ae_comp: item.comp,
          ae_rqindex: item.rqindex,
          ae_is_movie: !item.isSequence,
          ae_output_dir: outDir,
          ae_output_pattern: outName,
        })
      })
    }

    const { error: insErr } = await supabase.from('render_jobs').insert(chunkRows)
    if (insErr) throw new Error(`creating chunks: ${insErr.message}`)

    // Record the discovered queue + totals on the parent for visibility.
    if (job.parent_job_id) {
      await update(job.parent_job_id, {
        render_queue: queue.items,
        total_frames: totalFrames,
        chunk_count: chunkRows.length,
        progress_message: `Render queue: ${queue.items.length} item(s) → ${chunkRows.length} chunk(s) across ${workerCount} AE worker(s)`,
      })
    }

    await update(job.id, { status: 'complete', progress_percent: 100, progress_message: 'Queue inspected' })
    console.log(`[ae] inspect ${job.id}: ${queue.items.length} queued item(s) → ${chunkRows.length} chunk(s)`)
  } catch (err: any) {
    const message = err?.message || String(err)
    console.error(`[ae] inspect ${job.id} failed:`, message)
    await update(job.id, { status: 'failed', error_message: message })
    if (job.parent_job_id) {
      await update(job.parent_job_id, { status: 'failed', error_message: `Render-queue inspection failed: ${message}` })
    }
  } finally {
    setCurrentJob(null)
  }
}

// ─── AE chunk ──────────────────────────────────────────────────────────────

export async function processAeChunk(job: ClaimedJob): Promise<void> {
  setCurrentJob(job.id)
  const startedAt = new Date()

  try {
    await update(job.id, {
      status: 'processing',
      processing_started_at: startedAt.toISOString(),
      progress_percent: 0,
      progress_message: `Rendering frames ${job.frame_start}-${job.frame_end}...`,
    })

    if (!config.aerenderPath) throw new Error('Worker claimed an AE chunk but AERENDER_PATH is not set')
    if (!job.ae_project_path) throw new Error('AE chunk has no ae_project_path')
    if (job.ae_rqindex == null && !job.ae_comp) throw new Error('AE chunk has neither ae_rqindex nor ae_comp')

    // Resolve the .aep off the local Dropbox sync folder.
    const project = resolveDropboxPath(job.ae_project_path)
    if (!project) {
      throw new Error(
        `Project not found locally: ${job.ae_project_path}. Ensure Dropbox has fully synced it under DROPBOX_SYNC_PATH=${config.dropboxSyncPath}.`,
      )
    }

    // Resolve (and create) the shared output folder for the frames.
    const outDir = resolveDropboxDir(job.ae_output_dir || path.dirname(job.ae_project_path))
    if (!outDir) throw new Error('Could not resolve AE output directory (is DROPBOX_SYNC_PATH set?)')
    const pattern = job.ae_output_pattern || `${job.ae_comp || 'comp'}_[#####].png`
    const outputPath = path.join(outDir, pattern)
    ensureOutputDir(outputPath)

    const args = buildAerenderArgs({
      projectPath: project.localPath,
      // Prefer render-queue-driven mode (inherits the item's RS + OM); fall back
      // to explicit comp/templates for programmatic submissions.
      rqindex: job.ae_rqindex ?? undefined,
      comp: job.ae_comp || undefined,
      frameStart: job.frame_start ?? 0,
      frameEnd: job.frame_end ?? 0,
      outputPath,
      renderSettingsTemplate: job.ae_render_settings_template || undefined,
      outputModuleTemplate: job.ae_output_module_template || undefined,
    })

    await update(job.id, {
      aerender_command: aerenderArgsToShellCommand(args, config.aerenderPath),
      output_path: outputPath,
    })

    let lastReport = 0
    const result = await runAerender({
      aerenderPath: config.aerenderPath,
      args,
      frameStart: job.frame_start ?? 0,
      frameEnd: job.frame_end ?? 0,
      onProgress: (info) => {
        const now = Date.now()
        if (now - lastReport < 5000) return
        lastReport = now
        update(job.id, {
          progress_percent: info.percent,
          progress_message: `Frame ${info.current_frame} (${info.percent}% of chunk ${job.frame_start}-${job.frame_end})`,
        }).catch(() => {})
      },
    })

    if (result.exitCode !== 0) {
      const tail = result.output.split(/\r?\n/).slice(-12).join('\n')
      throw new Error(`aerender exited with code ${result.exitCode}.\nLast lines:\n${tail}`)
    }

    const elapsed = (Date.now() - startedAt.getTime()) / 1000
    await update(job.id, {
      status: 'complete',
      completed_at: new Date().toISOString(),
      progress_percent: 100,
      progress_message: 'Chunk complete',
      duration_seconds: elapsed,
    })
    console.log(`[ae] chunk ${job.id} (frames ${job.frame_start}-${job.frame_end}) done in ${elapsed.toFixed(1)}s`)

    if (job.parent_job_id) {
      await maybeFinalizeParent(job.parent_job_id)
    }
  } catch (err: any) {
    const message = err?.message || String(err)
    console.error(`[ae] chunk ${job.id} failed:`, message)
    await update(job.id, { status: 'failed', error_message: message })
    if (job.parent_job_id) {
      await failParent(job.parent_job_id, `Chunk ${job.chunk_index ?? '?'} failed: ${message}`)
    }
  } finally {
    setCurrentJob(null)
  }
}

// ─── Finalize: enqueue the stitch once all chunks are complete ───────────────

async function maybeFinalizeParent(parentId: string): Promise<void> {
  // Count siblings and how many are complete.
  const { data: chunks } = await supabase
    .from('render_jobs')
    .select('id, status, frame_start')
    .eq('parent_job_id', parentId)
    .eq('job_type', 'ae_chunk')

  if (!chunks || chunks.length === 0) return
  const allComplete = chunks.every((c: any) => c.status === 'complete')
  if (!allComplete) return

  // Atomically claim finalize rights on the parent. Only one worker wins.
  const { data: won } = await supabase
    .from('render_jobs')
    .update({ claimed_by: FINALIZE_SENTINEL, updated_at: new Date().toISOString() })
    .eq('id', parentId)
    .eq('job_type', 'ae_render')
    .is('claimed_by', null)
    .select('id')
    .maybeSingle()

  if (!won) return // another worker is finalizing

  const { data: parent } = await supabase.from('render_jobs').select('*').eq('id', parentId).maybeSingle()
  if (!parent) return

  // Only stitch when a delivery profile was attached AND we have a single shared
  // sequence to encode (the explicit/programmatic path). The render-queue-driven
  // flow honors the project's own output (sequence or movie) — the rendered
  // frames ARE the deliverable — so it completes directly.
  const isSequence = !!parent.ae_output_pattern && /\[#+\]|#/.test(parent.ae_output_pattern)
  const shouldStitch = !!parent.delivery_profile_id && !!parent.ae_output_dir && isSequence

  if (!shouldStitch) {
    await update(parentId, {
      status: 'complete',
      completed_at: new Date().toISOString(),
      progress_percent: 100,
      progress_message: 'Render complete — all chunks rendered',
    })
    console.log(`[ae] parent ${parentId}: all chunks complete (no stitch)`)
    return
  }

  await update(parentId, {
    progress_percent: 100,
    progress_message: 'All chunks rendered — queuing stitch...',
  })

  await supabase.from('render_jobs').insert({
    job_type: 'ae_stitch',
    status: 'pending',
    parent_job_id: parentId,
    requested_by: parent.requested_by,
    slack_channel: parent.slack_channel,
    slack_thread_ts: parent.slack_thread_ts,
    source_files: [],
    ae_comp: parent.ae_comp,
    ae_output_dir: parent.ae_output_dir,
    ae_output_pattern: parent.ae_output_pattern,
    frame_rate: parent.frame_rate,
    frame_start: parent.frame_start ?? 0,   // sequence start_number for the stitch
    total_frames: parent.total_frames,
    delivery_profile_id: parent.delivery_profile_id,
    profile_snapshot: parent.profile_snapshot,
    output_filename: parent.output_filename,
  })

  console.log(`[ae] parent ${parentId}: all chunks complete, stitch job queued`)
}

async function failParent(parentId: string, message: string): Promise<void> {
  // Guard with the same sentinel so we don't clobber a successful finalize.
  await supabase
    .from('render_jobs')
    .update({
      status: 'failed',
      claimed_by: FINALIZE_SENTINEL,
      error_message: message,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parentId)
    .eq('job_type', 'ae_render')
    .is('claimed_by', null)
}

// ─── AE stitch ───────────────────────────────────────────────────────────────

export async function processAeStitch(job: ClaimedJob): Promise<void> {
  setCurrentJob(job.id)
  const startedAt = new Date()

  try {
    await update(job.id, {
      status: 'processing',
      processing_started_at: startedAt.toISOString(),
      progress_percent: 0,
      progress_message: 'Stitching image sequence...',
    })

    const outDir = resolveDropboxDir(job.ae_output_dir || '')
    if (!outDir) throw new Error('Could not resolve AE output directory for stitch')

    // Convert AE's "[#####]" placeholder to FFmpeg's "%05d" so it can read the
    // sequence the chunks wrote.
    const aePattern = job.ae_output_pattern || `${job.ae_comp}_[#####].png`
    const ffPattern = aeBracketToPrintf(aePattern)
    const sequencePattern = path.join(outDir, ffPattern)

    const outputFilename = job.output_filename || `${job.ae_comp || 'render'}.mov`
    const outputPath = path.join(outDir, outputFilename)
    ensureOutputDir(outputPath)

    const profile = job.profile_snapshot || {}
    const args = buildStitchArgs({
      sequencePattern,
      startNumber: job.frame_start ?? 0,
      frameRate: job.frame_rate || profile.frame_rate || '24',
      outputPath,
      videoCodec: profile.video_codec,
      resolutionW: profile.resolution_w,
      resolutionH: profile.resolution_h,
      pixelFormat: profile.pixel_format,
    })

    await update(job.id, { ffmpeg_command: args.join(' '), output_path: outputPath, output_filename: outputFilename })

    const totalFrames = job.total_frames || 0
    const fps = Number(job.frame_rate || profile.frame_rate || '24') || 24
    const totalSeconds = totalFrames > 0 ? totalFrames / fps : 0

    let lastReport = 0
    const result = await runFFmpeg({
      ffmpegPath: config.ffmpegPath,
      args,
      totalDurationSeconds: totalSeconds,
      onProgress: (info) => {
        const now = Date.now()
        if (now - lastReport < 5000) return
        lastReport = now
        update(job.id, {
          progress_percent: info.percent,
          progress_message: `Encoding ${info.percent}%`,
        }).catch(() => {})
      },
    })

    if (result.exitCode !== 0) {
      try { fs.unlinkSync(outputPath) } catch {}
      const tail = result.stderr.split(/\r?\n/).slice(-10).join('\n')
      throw new Error(`FFmpeg stitch exited with code ${result.exitCode}.\nLast lines:\n${tail}`)
    }

    const outStat = fs.statSync(outputPath)
    const elapsed = (Date.now() - startedAt.getTime()) / 1000
    await update(job.id, {
      status: 'complete',
      completed_at: new Date().toISOString(),
      progress_percent: 100,
      progress_message: 'Complete',
      output_size_bytes: outStat.size,
      duration_seconds: elapsed,
    })

    // Mark the parent render complete and carry the final output up to it.
    if (job.parent_job_id) {
      await update(job.parent_job_id, {
        status: 'complete',
        completed_at: new Date().toISOString(),
        progress_percent: 100,
        progress_message: 'Render complete',
        output_path: outputPath,
        output_filename: outputFilename,
        output_size_bytes: outStat.size,
      })
    }
    console.log(`[ae] stitch ${job.id} complete in ${elapsed.toFixed(1)}s → ${outputPath}`)
  } catch (err: any) {
    const message = err?.message || String(err)
    console.error(`[ae] stitch ${job.id} failed:`, message)
    await update(job.id, { status: 'failed', error_message: message })
    if (job.parent_job_id) {
      await update(job.parent_job_id, { status: 'failed', error_message: `Stitch failed: ${message}` })
    }
  } finally {
    setCurrentJob(null)
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** "Comp_[#####].png" → "Comp_%05d.png" */
function aeBracketToPrintf(pattern: string): string {
  return pattern.replace(/\[(#+)\]/g, (_m, hashes) => `%0${hashes.length}d`)
}

async function update(jobId: string, patch: Record<string, any>): Promise<void> {
  await supabase
    .from('render_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
}
