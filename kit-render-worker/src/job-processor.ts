// @ts-nocheck
/**
 * Process one claimed job end-to-end:
 *   1. Mark processing
 *   2. Resolve source file (Dropbox sync path → local path)
 *   3. Probe duration (for progress tracking)
 *   4. Two-pass loudness analysis if profile.lufs_target set
 *   5. Build final FFmpeg args + run with progress reporting
 *   6. Apply naming template → output filename in /delivery/ subfolder
 *   7. Mark complete + update DB with output path/size/duration
 */

import * as path from 'path'
import * as fs from 'fs'
import { supabase } from './supabase'
import { config } from './config'
import { setCurrentJob } from './heartbeat'
import type { ClaimedJob } from './job-claimer'
import { resolveDropboxPath, ensureOutputDir } from './dropbox/file-resolver'
import { runFFmpeg, probeDurationSeconds } from './ffmpeg/runner'
import { runLoudnessAnalysis } from './ffmpeg/loudness'
import { buildFFmpegArgs, argsToShellCommand } from './ffmpeg/command-builder'
import { buildOutputFilename } from './ffmpeg/naming'
import { processAeChunk, processAeStitch } from './ae-processor'

export async function processJob(job: ClaimedJob): Promise<void> {
  // Route AE jobs to their dedicated processors; transcode falls through.
  if (job.job_type === 'ae_chunk') return processAeChunk(job)
  if (job.job_type === 'ae_stitch') return processAeStitch(job)
  return processTranscodeJob(job)
}

async function processTranscodeJob(job: ClaimedJob): Promise<void> {
  setCurrentJob(job.id)
  const startedAt = new Date()

  try {
    await markStatus(job.id, 'processing', {
      processing_started_at: startedAt.toISOString(),
      progress_message: 'Starting transcode...',
      progress_percent: 0,
    })

    const profile = job.profile_snapshot
    if (!profile) throw new Error('Job has no profile_snapshot')

    const sourceFile = (job.source_files || [])[0]
    if (!sourceFile) throw new Error('Job has no source files')

    // ── Resolve source ───────────────────────────────────────
    const resolved = resolveDropboxPath(sourceFile.path)
    if (!resolved) {
      throw new Error(
        `Source file not found locally: ${sourceFile.path}. Verify Dropbox has synced this path under DROPBOX_SYNC_PATH=${config.dropboxSyncPath}.`,
      )
    }

    // ── Probe duration for progress tracking ─────────────────
    await updateProgress(job.id, 5, 'Probing source duration...')
    const duration = await probeDurationSeconds(config.ffmpegPath, resolved.localPath)

    // ── Build output path ────────────────────────────────────
    const outputFilename = profile.naming_template && job.naming_fields
      ? buildOutputFilename(profile.naming_template, job.naming_fields, profile.container || 'mov')
      : path.basename(resolved.localPath)
    const sourceDir = path.dirname(resolved.localPath)
    const outputDir = path.join(sourceDir, 'delivery')
    const outputPath = path.join(outputDir, outputFilename)
    ensureOutputDir(outputPath)

    // ── Pass 1: loudness analysis (if profile sets lufs_target) ──
    let loudness = null
    if (profile.lufs_target != null) {
      await updateProgress(job.id, 10, 'Pass 1/2: Analyzing loudness...')
      loudness = await runLoudnessAnalysis({
        ffmpegPath: config.ffmpegPath,
        profile,
        sourcePath: resolved.localPath,
      })
    }

    // ── Pass 2: full transcode ───────────────────────────────
    const args = buildFFmpegArgs({
      profile,
      sourceFiles: [{ path: resolved.localPath, type: 'video', size_bytes: resolved.sizeBytes }],
      outputPath,
      loudness,
    })
    const cmdStr = argsToShellCommand(args, config.ffmpegPath)

    await supabase
      .from('render_jobs')
      .update({
        ffmpeg_command: cmdStr,
        output_path: outputPath,
        output_filename: outputFilename,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)

    const passLabel = loudness ? 'Pass 2/2' : 'Encoding'
    await updateProgress(job.id, 15, `${passLabel}: Encoding video + audio...`)

    let lastReportTs = 0
    const result = await runFFmpeg({
      ffmpegPath: config.ffmpegPath,
      args,
      totalDurationSeconds: duration,
      onProgress: (info) => {
        const now = Date.now()
        if (now - lastReportTs < 5000) return
        lastReportTs = now
        // Scale 15-95% to the FFmpeg progress band (loudness took 5-15%, finalize 95-100)
        const scaled = Math.round(15 + (info.percent * 0.8))
        const eta = info.eta_seconds != null ? ` (ETA ${Math.round(info.eta_seconds)}s)` : ''
        updateProgress(job.id, scaled, `${passLabel}: ${info.percent}%${eta}`).catch(() => {})
      },
    })

    if (result.exitCode !== 0) {
      // Best-effort cleanup of partial output
      try { fs.unlinkSync(outputPath) } catch {}
      const tail = result.stderr.split(/\r?\n/).slice(-10).join('\n')
      throw new Error(`FFmpeg exited with code ${result.exitCode}.\nLast lines:\n${tail}`)
    }

    // ── Finalize ─────────────────────────────────────────────
    const outStat = fs.statSync(outputPath)
    const elapsedSeconds = (Date.now() - startedAt.getTime()) / 1000
    await supabase
      .from('render_jobs')
      .update({
        status: 'complete',
        completed_at: new Date().toISOString(),
        progress_percent: 100,
        progress_message: 'Complete',
        output_size_bytes: outStat.size,
        duration_seconds: elapsedSeconds,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)

    console.log(`[processor] Job ${job.id} complete in ${elapsedSeconds.toFixed(1)}s → ${outputPath}`)
  } catch (err: any) {
    const message = err?.message || String(err)
    console.error(`[processor] Job ${job.id} failed:`, message)
    await supabase
      .from('render_jobs')
      .update({
        status: 'failed',
        error_message: message,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job.id)
  } finally {
    setCurrentJob(null)
  }
}

async function markStatus(jobId: string, status: string, extras: Record<string, any> = {}): Promise<void> {
  await supabase
    .from('render_jobs')
    .update({ status, updated_at: new Date().toISOString(), ...extras })
    .eq('id', jobId)
}

async function updateProgress(jobId: string, percent: number, message: string): Promise<void> {
  await supabase
    .from('render_jobs')
    .update({
      progress_percent: percent,
      progress_message: message,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
}
