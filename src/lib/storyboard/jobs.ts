// @ts-nocheck
/**
 * Storyboard job persistence — checkpoint + resume.
 *
 * Every provision call writes a row to `storyboard_jobs` BEFORE talking
 * to Boords. On success the row is marked complete. On failure it sits
 * as 'failed' until `/storyboard resume <jobId>` is invoked, which loads
 * the parsed frames and retries the create / append.
 *
 * Supabase isn't always present in dev (createAdminClient throws if env
 * vars are missing), so every helper is best-effort: errors are logged
 * and swallowed. A missing checkpoint never blocks a create.
 */

import { createAdminClient } from '../supabase/admin'
import type { BoordsFrame } from '../boords/client'

export interface StoryboardJob {
  id: string
  workspaceId: string | null
  userId: string | null
  channelId: string | null
  projectName: string
  frames: BoordsFrame[]
  lastFrameIndex: number
  status: 'pending' | 'in_progress' | 'complete' | 'failed'
  aspectRatio: string | null
  secondsPerFrame: number | null
  videoStyle: string | null
  modeUsed: string | null
  boordsStoryboardId: string | null
  boordsUrl: string | null
  lastError: string | null
}

export interface CreateJobInput {
  workspaceId?: string | null
  userId?: string | null
  channelId?: string | null
  projectName: string
  frames: BoordsFrame[]
  aspectRatio?: string | null
  secondsPerFrame?: number | null
  videoStyle?: string | null
  modeUsed?: string | null
}

function client() {
  try {
    return createAdminClient()
  } catch {
    return null
  }
}

function fromRow(row: any): StoryboardJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    channelId: row.channel_id,
    projectName: row.project_name,
    frames: Array.isArray(row.frames) ? row.frames : [],
    lastFrameIndex: row.last_frame_index ?? 0,
    status: row.status,
    aspectRatio: row.aspect_ratio,
    secondsPerFrame: row.seconds_per_frame,
    videoStyle: row.video_style,
    modeUsed: row.mode_used,
    boordsStoryboardId: row.boords_storyboard_id,
    boordsUrl: row.boords_url,
    lastError: row.last_error,
  }
}

export async function createJob(input: CreateJobInput): Promise<string | null> {
  const supabase = client()
  if (!supabase) return null
  try {
    const { data, error } = await supabase
      .from('storyboard_jobs')
      .insert({
        workspace_id: input.workspaceId || null,
        user_id: input.userId || null,
        channel_id: input.channelId || null,
        project_name: input.projectName,
        frames: input.frames,
        last_frame_index: 0,
        status: 'pending',
        aspect_ratio: input.aspectRatio || null,
        seconds_per_frame: input.secondsPerFrame || null,
        video_style: input.videoStyle || null,
        mode_used: input.modeUsed || null,
      })
      .select('id')
      .single()
    if (error) throw error
    return data.id as string
  } catch (err: any) {
    console.warn('[storyboard.jobs] createJob failed (continuing):', err.message)
    return null
  }
}

export async function loadJob(jobId: string): Promise<StoryboardJob | null> {
  const supabase = client()
  if (!supabase) return null
  try {
    const { data, error } = await supabase
      .from('storyboard_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle()
    if (error) throw error
    return data ? fromRow(data) : null
  } catch (err: any) {
    console.warn('[storyboard.jobs] loadJob failed:', err.message)
    return null
  }
}

export async function markJobInProgress(jobId: string): Promise<void> {
  await update(jobId, { status: 'in_progress' })
}

export async function markJobComplete(jobId: string, frameCount: number): Promise<void> {
  await update(jobId, { status: 'complete', last_frame_index: frameCount })
}

export async function markJobFailed(jobId: string, error: string): Promise<void> {
  await update(jobId, { status: 'failed', last_error: error.slice(0, 1000) })
}

export async function setJobBoordsId(
  jobId: string,
  boordsId: string,
  url?: string,
): Promise<void> {
  await update(jobId, { boords_storyboard_id: boordsId, boords_url: url || null })
}

export async function advanceJobIndex(jobId: string, index: number): Promise<void> {
  await update(jobId, { last_frame_index: index })
}

async function update(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const supabase = client()
  if (!supabase) return
  try {
    const { error } = await supabase
      .from('storyboard_jobs')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', jobId)
    if (error) throw error
  } catch (err: any) {
    console.warn(`[storyboard.jobs] update(${jobId}) failed:`, err.message)
  }
}
