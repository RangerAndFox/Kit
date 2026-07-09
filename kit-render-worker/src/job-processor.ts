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
import { runQualityControl } from './ffmpeg/qc'
import { processAeInspect, processAeChunk, processAeStitch } from './ae-processor'

export async function processJob(job: ClaimedJob): Promise<void> {
  // Route AE jobs to their dedicated processors; transcode falls through.
  if (job.job_type === 'ae_inspect') return processAeInspect(job)
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

    const sources = job.source_files || []
    if (sources.length === 0) throw new Error('Job has no source files')
    const videoSource = sources.find((s) => s.type === 'video') || sources[0]
    const audioSource = sources.find((s) => s.type === 'audio') || null

    // ── Resolve sources (video + optional separate audio mix) ──
    const resolvedVideo = resolveDropboxPath(videoSource.path)
    if (!resolvedVideo) {
      throw new Error(
        `Source video not found locally: ${videoSource.path}. Verify Dropbox has synced this path under DROPBOX_SYNC_PATH=${config.dropboxSyncPath}.`,
      )
    }
    let resolvedAudio = null
    if (audioSource) {
      resolvedAudio = resolveDropboxPath(audioSource.path)
      if (!resolvedAudio) {
        throw new Error(
          `Source audio not found locally: ${audioSource.path}. Verify Dropbox has synced it under DROPBOX_SYNC_PATH=${config.dropboxSyncPath}.`,
        )
      }
    }

    // ── Probe duration for progress tracking (from the picture) ──
    await updateProgress(job.id, 5, 'Probing source duration...')
    const duration = await probeDurationSeconds(config.ffmpegPath, resolvedVideo.localPath)

    // ── Build output path ────────────────────────────────────
    const outputFilename = profile.naming_template && job.naming_fields
      ? buildOutputFilename(profile.naming_template, job.naming_fields, profile.container || 'mov')
      : path.basename(resolvedVideo.localPath)
    const sourceDir = path.dirname(resolvedVideo.localPath)
    const outputDir = path.join(sourceDir, 'delivery')
    const outputPath = path.join(outputDir, outputFilename)
    ensureOutputDir(outputPath)

    // ── Pass 1: loudness analysis (if profile sets lufs_target) ──
    // Measure the stream pass 2 will normalize: the external mix when present,
    // otherwise the picture's embedded audio.
    let loudness = null
    if (profile.lufs_target != null) {
      await updateProgress(job.id, 10, 'Pass 1/2: Analyzing loudness...')
      loudness = await runLoudnessAnalysis({
        ffmpegPath: config.ffmpegPath,
        profile,
        sourcePath: resolvedAudio ? resolvedAudio.localPath : resolvedVideo.localPath,
      })
    }

    // ── Pass 2: full transcode ───────────────────────────────
    // Video first (input 0), then the audio mix (input 1) so the builder's
    // -map indices line up.
    const builderSources = [
      { path: resolvedVideo.localPath, type: 'video', size_bytes: resolvedVideo.sizeBytes },
      ...(resolvedAudio
        ? [{ path: resolvedAudio.localPath, type: 'audio', size_bytes: resolvedAudio.sizeBytes }]
        : []),
    ]
    const args = buildFFmpegArgs({ profile, sourceFiles: builderSources, outputPath, loudness })
    const cmdStr = argsToShellCommand(args, config.ffmpegPath)

    await ownedUpdate(job.id, {
      ffmpeg_command: cmdStr,
      output_path: outputPath,
      output_filename: outputFilename,
    })

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

    // ── QC: ffprobe the output and confirm it matches the spec ──
    await updateProgress(job.id, 97, 'QC: verifying output against spec...')
    let qcStatus = null
    try {
      const report = await runQualityControl({
        ffmpegPath: config.ffmpegPath,
        outputPath,
        profile,
      })
      qcStatus = report.checks.map((c) => ({
        text: `${c.name}: expected ${c.expected}, got ${c.actual}`,
        checked: c.pass,
      }))
      console.log(`[processor] Job ${job.id} QC ${report.pass ? 'passed' : 'FLAGGED'}`)
    } catch (qcErr: any) {
      console.warn(`[processor] Job ${job.id} QC probe failed: ${qcErr.message || qcErr}`)
      qcStatus = [{ text: `QC probe failed: ${qcErr.message || qcErr}`, checked: false }]
    }

    // ── Finalize ─────────────────────────────────────────────
    const outStat = fs.statSync(outputPath)
    const elapsedSeconds = (Date.now() - startedAt.getTime()) / 1000
    const finalized = await ownedUpdate(job.id, {
      status: 'complete',
      completed_at: new Date().toISOString(),
      progress_percent: 100,
      progress_message: 'Complete',
      output_size_bytes: outStat.size,
      duration_seconds: elapsedSeconds,
      qc_checklist_status: qcStatus,
    })

    if (!finalized) {
      // The stale-worker sweep reassigned this job while we were rendering
      // (our heartbeats stalled). Another worker owns it now — remove our
      // output so we don't leave a duplicate/conflicting deliverable in the
      // Dropbox-synced folder.
      console.warn(
        `[processor] Job ${job.id} was reassigned while we rendered — discarding our output`,
      )
      try { fs.unlinkSync(outputPath) } catch {}
      return
    }

    console.log(`[processor] Job ${job.id} complete in ${elapsedSeconds.toFixed(1)}s → ${outputPath}`)
  } catch (err: any) {
    const message = err?.message || String(err)
    console.error(`[processor] Job ${job.id} failed:`, message)
    // Ownership-guarded: if the job was reassigned, don't stamp 'failed' over
    // another worker's in-progress row.
    await ownedUpdate(job.id, { status: 'failed', error_message: message })
  } finally {
    setCurrentJob(null)
  }
}

/**
 * Update a job row ONLY while this worker still owns the claim. Once the
 * stale-worker sweep clears claimed_by (or another worker re-claims), our
 * writes match zero rows instead of clobbering the new owner's state.
 * Returns true if the row was still ours.
 */
async function ownedUpdate(jobId: string, patch: Record<string, any>): Promise<boolean> {
  const { data } = await supabase
    .from('render_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('claimed_by', config.hostname)
    .select('id')
  return (data?.length || 0) > 0
}

async function markStatus(jobId: string, status: string, extras: Record<string, any> = {}): Promise<void> {
  await ownedUpdate(jobId, { status, ...extras })
}

async function updateProgress(jobId: string, percent: number, message: string): Promise<void> {
  await ownedUpdate(jobId, { progress_percent: percent, progress_message: message })
}
