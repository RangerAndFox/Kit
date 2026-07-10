/**
 * Supabase orchestration for the After Effects render farm.
 *
 * submitAeRender fans one render request out into:
 *   • one parent row  (job_type 'ae_render')  — a tracker, never claimed
 *   • N chunk rows     (job_type 'ae_chunk')   — frame ranges, claimed by AE workers
 * The stitch row ('ae_stitch') is created by whichever worker finishes the last
 * chunk (see kit-render-worker/src/ae-processor.ts).
 *
 * Spec: AE-RENDER-FARM-SPEC.md.
 */

import { createAdminClient } from '../supabase/admin'
import { getProfile } from './storage'
import { planChunks, chooseChunkCount } from './frame-planner'

export interface AeRenderRequest {
  projectPath: string          // Dropbox path to the .aep
  comp: string                 // composition name
  totalFrames: number          // number of frames in the comp
  frameRate: string            // comp fps, e.g. "59.94"
  requestedBy: string          // Slack user id
  startFrame?: number          // default 0
  chunkCount?: number          // override the auto-computed split
  renderSettingsTemplate?: string
  outputModuleTemplate?: string
  outputExtension?: string     // image-sequence extension, default "png"
  deliveryProfileId?: string   // delivery profile to encode the stitched movie with
  outputFilename?: string      // final movie filename, default "<comp>.mov"
  slackChannel?: string
  slackThreadTs?: string
}

export interface AeRenderSummary {
  parent: any
  chunks: any[]
  workerCount: number
  chunkCount: number
}

/** Count AE-capable workers currently online (used to size the frame split). */
export async function countOnlineAeWorkers(): Promise<number> {
  const sb = createAdminClient()
  const { count } = await sb
    .from('render_workers')
    .select('hostname', { count: 'exact', head: true })
    .eq('ae_capable', true)
    .eq('status', 'online')
  return count || 0
}

export async function submitAeRender(req: AeRenderRequest): Promise<AeRenderSummary> {
  const sb = createAdminClient()
  if (!req.totalFrames || req.totalFrames <= 0) throw new Error('submitAeRender: totalFrames must be > 0')

  const startFrame = req.startFrame ?? 0
  const workerCount = await countOnlineAeWorkers()
  const chunkCount = req.chunkCount && req.chunkCount > 0
    ? req.chunkCount
    : chooseChunkCount(req.totalFrames, workerCount)
  const chunks = planChunks(req.totalFrames, chunkCount, startFrame)

  // Derive shared output folder + sequence pattern + final movie name.
  const baseDir = dropboxDirname(req.projectPath)
  const safeComp = sanitizeName(req.comp)
  const outputDir = `${baseDir}/render/${safeComp}`
  const ext = (req.outputExtension || 'png').replace(/^\./, '')
  const outputPattern = `${safeComp}_[#####].${ext}`
  const outputFilename = req.outputFilename || `${safeComp}.mov`

  const profile = req.deliveryProfileId ? await getProfile(req.deliveryProfileId) : null

  // ── Parent tracker row ──────────────────────────────────────
  const { data: parent, error: parentErr } = await sb
    .from('render_jobs')
    .insert({
      job_type: 'ae_render',
      status: 'processing',          // tracker — excluded from the pending queue
      requested_by: req.requestedBy,
      slack_channel: req.slackChannel ?? null,
      slack_thread_ts: req.slackThreadTs ?? null,
      source_files: [{ path: req.projectPath, type: 'video', size_bytes: 0 }],
      ae_project_path: req.projectPath,
      ae_comp: req.comp,
      ae_render_settings_template: req.renderSettingsTemplate ?? null,
      ae_output_module_template: req.outputModuleTemplate ?? null,
      ae_output_dir: outputDir,
      ae_output_pattern: outputPattern,
      output_filename: outputFilename,
      frame_rate: req.frameRate,
      frame_start: startFrame,
      total_frames: req.totalFrames,
      chunk_count: chunks.length,
      delivery_profile_id: req.deliveryProfileId ?? null,
      profile_snapshot: profile ?? null,
      progress_message: `Split into ${chunks.length} chunk(s) across ${workerCount} AE worker(s)`,
    } as any)
    .select('*')
    .single()
  if (parentErr) throw new Error(`submitAeRender(parent): ${parentErr.message}`)

  // ── Chunk rows ──────────────────────────────────────────────
  const chunkRows = chunks.map((c) => ({
    job_type: 'ae_chunk',
    status: 'pending',
    parent_job_id: parent.id,
    chunk_index: c.index,
    chunk_count: chunks.length,
    frame_start: c.frameStart,
    frame_end: c.frameEnd,
    total_frames: req.totalFrames,
    frame_rate: req.frameRate,
    requested_by: req.requestedBy,
    slack_channel: req.slackChannel ?? null,
    slack_thread_ts: req.slackThreadTs ?? null,
    source_files: [{ path: req.projectPath, type: 'video', size_bytes: 0 }],
    ae_project_path: req.projectPath,
    ae_comp: req.comp,
    ae_render_settings_template: req.renderSettingsTemplate ?? null,
    ae_output_module_template: req.outputModuleTemplate ?? null,
    ae_output_dir: outputDir,
    ae_output_pattern: outputPattern,
    delivery_profile_id: req.deliveryProfileId ?? null,
  }))

  const { data: insertedChunks, error: chunkErr } = await sb
    .from('render_jobs')
    .insert(chunkRows as any)
    .select('*')
  if (chunkErr) throw new Error(`submitAeRender(chunks): ${chunkErr.message}`)

  return { parent, chunks: insertedChunks || [], workerCount, chunkCount: chunks.length }
}

/**
 * Render a project straight from its own After Effects render queue. The
 * submitter supplies only the .aep path — Kit can't open the project, so the
 * queue is read downstream.
 *
 * Two backends (selected by RENDER_BACKEND, default 'kit-worker'):
 *   • kit-worker — creates the parent + an `ae_inspect` job that an AE-capable
 *     worker runs to read the queue and fan out chunks (see ae-processor.ts).
 *   • deadline   — creates just the parent (render_backend='deadline'); the
 *     kit-deadline-relay reads the queue and submits Deadline jobs.
 */
export async function submitAeRenderFromProject(req: {
  projectPath: string
  requestedBy: string
  slackChannel?: string
  slackThreadTs?: string
}): Promise<{ parent: any; inspect: any; backend: string }> {
  const sb = createAdminClient()
  const backend = process.env.RENDER_BACKEND === 'deadline' ? 'deadline' : 'kit-worker'

  const { data: parent, error: parentErr } = await sb
    .from('render_jobs')
    .insert({
      job_type: 'ae_render',
      status: 'processing',
      render_backend: backend,
      requested_by: req.requestedBy,
      slack_channel: req.slackChannel ?? null,
      slack_thread_ts: req.slackThreadTs ?? null,
      source_files: [{ path: req.projectPath, type: 'video', size_bytes: 0 }],
      ae_project_path: req.projectPath,
      progress_message:
        backend === 'deadline'
          ? 'Waiting for the Deadline relay to read the render queue...'
          : 'Waiting for an AE worker to read the render queue...',
    } as any)
    .select('*')
    .single()
  if (parentErr) throw new Error(`submitAeRenderFromProject(parent): ${parentErr.message}`)

  // The Deadline relay reads the queue + submits jobs itself, so it needs no
  // ae_inspect row. The kit-worker backend does.
  if (backend === 'deadline') {
    return { parent, inspect: null, backend }
  }

  const { data: inspect, error: inspectErr } = await sb
    .from('render_jobs')
    .insert({
      job_type: 'ae_inspect',
      status: 'pending',
      parent_job_id: parent.id,
      requested_by: req.requestedBy,
      slack_channel: req.slackChannel ?? null,
      slack_thread_ts: req.slackThreadTs ?? null,
      source_files: [{ path: req.projectPath, type: 'video', size_bytes: 0 }],
      ae_project_path: req.projectPath,
    } as any)
    .select('*')
    .single()
  if (inspectErr) throw new Error(`submitAeRenderFromProject(inspect): ${inspectErr.message}`)

  return { parent, inspect, backend }
}

/** Parents that need the Deadline relay to submit them (backend=deadline, unclaimed). */
export async function claimDeadlineParent(relayHost: string): Promise<any | null> {
  const sb = createAdminClient()
  const { data: candidates } = await sb
    .from('render_jobs')
    .select('id')
    .eq('job_type', 'ae_render')
    .eq('render_backend', 'deadline')
    .eq('status', 'processing')
    .is('claimed_by', null)
    .order('created_at', { ascending: true })
    .limit(1)
  if (!candidates || candidates.length === 0) return null

  const { data: claimed } = await sb
    .from('render_jobs')
    .update({ claimed_by: relayHost, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', candidates[0].id)
    .is('claimed_by', null)
    .select('*')
    .maybeSingle()
  return claimed || null
}

/**
 * Convert a farm UNC path (\\thewire\production\...) back to its Dropbox path
 * (/production/...) — the production tree syncs to Dropbox, and the transcode
 * workers resolve sources by Dropbox path. Returns null if the path isn't
 * under the farm root.
 */
export function uncToDropboxPath(uncPath: string): string | null {
  const root = (process.env.AE_FARM_UNC_ROOT || '\\\\thewire\\production').replace(/[\\/]+$/, '')
  const norm = (uncPath || '').replace(/\//g, '\\')
  if (!norm.toLowerCase().startsWith(root.toLowerCase())) return null
  const rest = norm.slice(root.length).replace(/\\/g, '/')
  return `/production${rest.startsWith('/') ? rest : `/${rest}`}`
}

export interface AeRenderStatus {
  parent: any
  chunks: any[]
  stitch: any | null
  chunksComplete: number
  chunksTotal: number
  percent: number
}

/** Aggregate a render's progress from its chunk + stitch rows. */
export async function getAeRenderStatus(parentId: string): Promise<AeRenderStatus | null> {
  const sb = createAdminClient()
  const { data: parent } = await sb.from('render_jobs').select('*').eq('id', parentId).maybeSingle()
  if (!parent) return null

  const { data: children } = await sb
    .from('render_jobs')
    .select('*')
    .eq('parent_job_id', parentId)
    .order('chunk_index', { ascending: true })

  const chunks = (children || []).filter((c: any) => c.job_type === 'ae_chunk')
  const stitch = (children || []).find((c: any) => c.job_type === 'ae_stitch') || null

  const chunksTotal = chunks.length || parent.chunk_count || 0
  const chunksComplete = chunks.filter((c: any) => c.status === 'complete').length

  // Render is 90% chunks + 10% stitch.
  const chunkAvg = chunks.length
    ? chunks.reduce((s: number, c: any) => s + (c.progress_percent || 0), 0) / chunks.length
    : 0
  const stitchPct = stitch?.status === 'complete' ? 100 : stitch?.progress_percent || 0
  const percent = Math.round(chunkAvg * 0.9 + stitchPct * 0.1)

  return { parent, chunks, stitch, chunksComplete, chunksTotal, percent }
}

export async function listAeRenders(limit = 25): Promise<any[]> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('render_jobs')
    .select('*')
    .eq('job_type', 'ae_render')
    .order('created_at', { ascending: false })
    .limit(limit)
  return data || []
}

// ─── helpers ────────────────────────────────────────────────────────────────

function dropboxDirname(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '' : trimmed.slice(0, idx)
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'comp'
}
