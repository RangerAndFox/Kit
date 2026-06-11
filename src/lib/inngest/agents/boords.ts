/**
 * Boords Agent — Storyboard & Script Visualization Expert
 *
 * Builds Boords storyboards from scripts. Knows how to:
 *   - Parse a script (paste, .docx, .txt) into frames
 *   - Auto-detect Audio/Visual tables vs. fall back to sentence split
 *   - Use AI to extract scenes when the script is prose
 *   - POST the whole storyboard + all frames in one Boords API call
 *
 * The orchestrator routes 'create a storyboard' / 'turn this script into
 * a storyboard' queries here.
 */

import { createStoryboard, appendFrames, listProjects, listStoryboards } from '@/lib/boords/client'
import { parseScript } from '@/lib/storyboard/parser'
import type { ExtractionMode } from '@/lib/storyboard/parser'
import {
  createJob,
  loadJob,
  markJobComplete,
  markJobFailed,
  markJobInProgress,
  setJobBoordsId,
  advanceJobIndex,
} from '@/lib/storyboard/jobs'
import type { AgentDefinition, AgentResult } from './types'

// ─── Action Handlers ───────────────────────────────────────

async function provision(payload: Record<string, unknown>): Promise<AgentResult> {
  const script = String(payload.script || payload.text || '').trim()
  const blank = Boolean(payload.blank)
  const projectName = String(
    payload.projectName || payload.name || 'Untitled Storyboard',
  ).trim()
  const mode = (payload.mode as ExtractionMode) || 'auto'
  const aspectRatio = (payload.aspectRatio as string) || '16:9'
  const secondsPerFrame = Number(payload.secondsPerFrame) || 5
  const videoStyle = (payload.videoStyle as string) || undefined
  const boordsProjectId = (payload.boordsProjectId as string) || undefined
  const workspaceId = (payload.workspaceId as string) || null
  const slackUserId = (payload.slackUserId as string) || null
  const channelId = (payload.channelId as string) || null

  if (!script && !blank) {
    return {
      agent: 'boords',
      action: 'provision',
      success: false,
      error: 'Need either a script (in `script`) or blank=true to create a placeholder storyboard.',
    }
  }

  let frames: any[] = []
  let modeUsed: string = 'sentence'
  let detectedTable = false

  try {
    if (!blank && script) {
      const parsed = await parseScript(script, mode, secondsPerFrame)
      frames = parsed.frames
      modeUsed = parsed.modeUsed
      detectedTable = parsed.detectedTable
      if (frames.length === 0) {
        return {
          agent: 'boords',
          action: 'provision',
          success: false,
          error: 'Parser produced zero frames from the script. Try a different extraction mode.',
        }
      }
      // Apply seconds-per-frame to every frame (Boords accepts duration per frame).
      frames = frames.map((f) => ({ ...f, duration: secondsPerFrame }))
    } else {
      // Blank storyboard: a single placeholder frame so the producer has somewhere to start.
      frames = [{ label: '1', sound: '', action: '', duration: secondsPerFrame }]
      modeUsed = 'blank'
    }
  } catch (err: any) {
    return { agent: 'boords', action: 'provision', success: false, error: err.message }
  }

  // Persist a checkpoint BEFORE talking to Boords. If the create call
  // fails partway, `/storyboard resume <jobId>` can pick up from here.
  const jobId = await createJob({
    workspaceId,
    userId: slackUserId,
    channelId,
    projectName,
    frames,
    aspectRatio,
    secondsPerFrame,
    videoStyle,
    modeUsed,
  })
  if (jobId) await markJobInProgress(jobId)

  const description = videoStyle
    ? `Style: ${videoStyle} • ${aspectRatio} • ${secondsPerFrame}s per frame`
    : `${aspectRatio} • ${secondsPerFrame}s per frame`

  try {
    const { storyboard } = await createStoryboard({
      name: projectName,
      projectId: boordsProjectId,
      description,
      aspectRatio: aspectRatio as any,
      frames,
    })

    if (jobId) {
      await setJobBoordsId(jobId, storyboard.id, storyboard.url)
      await markJobComplete(jobId, frames.length)
    }

    const totalSeconds = frames.length * secondsPerFrame
    const mins = Math.floor(totalSeconds / 60)
    const secs = totalSeconds % 60
    const runtime = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`

    return {
      agent: 'boords',
      action: 'provision',
      success: true,
      url: storyboard.url,
      id: storyboard.id,
      message:
        blank
          ? `Created blank storyboard "${storyboard.name}" (1 placeholder frame)`
          : `Created "${storyboard.name}" with ${frames.length} frame${frames.length === 1 ? '' : 's'} (${runtime}, via ${modeUsed}${detectedTable ? ' — A/V table detected' : ''})`,
      data: {
        jobId,
        storyboardId: storyboard.id,
        storyboardName: storyboard.name,
        frameCount: frames.length,
        runtimeSeconds: totalSeconds,
        modeUsed,
        detectedTable,
        // Surface a small preview for the summary card to render.
        preview: frames.slice(0, 3).map((f) => ({
          label: f.label,
          sound: (f.sound || '').slice(0, 120),
          action: (f.action || '').slice(0, 120),
        })),
      },
    }
  } catch (err: any) {
    if (jobId) await markJobFailed(jobId, err.message || String(err))
    return {
      agent: 'boords',
      action: 'provision',
      success: false,
      error: err.message || String(err),
      data: jobId
        ? { jobId, hint: `Retry with: /storyboard resume ${jobId}` }
        : undefined,
    }
  }
}

/**
 * Resume a failed provision. Loads the persisted frames from the job row
 * and either retries createStoryboard (if no Boords storyboard exists
 * yet) or appendFrames (if some frames already landed).
 */
async function resume(payload: Record<string, unknown>): Promise<AgentResult> {
  const jobId = String(payload.jobId || '').trim()
  if (!jobId) {
    return {
      agent: 'boords',
      action: 'resume',
      success: false,
      error: 'Missing jobId. Usage: provide payload.jobId.',
    }
  }

  const job = await loadJob(jobId)
  if (!job) {
    return {
      agent: 'boords',
      action: 'resume',
      success: false,
      error: `No storyboard job found with id ${jobId}.`,
    }
  }
  if (job.status === 'complete') {
    return {
      agent: 'boords',
      action: 'resume',
      success: true,
      url: job.boordsUrl || undefined,
      id: job.boordsStoryboardId || undefined,
      message: `Job ${jobId} already completed.`,
      data: {
        jobId,
        storyboardId: job.boordsStoryboardId,
        frameCount: job.frames.length,
      },
    }
  }

  await markJobInProgress(jobId)
  const aspectRatio = job.aspectRatio || '16:9'
  const secondsPerFrame = job.secondsPerFrame || 5
  const description = job.videoStyle
    ? `Style: ${job.videoStyle} • ${aspectRatio} • ${secondsPerFrame}s per frame`
    : `${aspectRatio} • ${secondsPerFrame}s per frame`

  try {
    // No Boords storyboard yet → retry the whole create.
    if (!job.boordsStoryboardId) {
      const { storyboard } = await createStoryboard({
        name: job.projectName,
        description,
        aspectRatio: aspectRatio as any,
        frames: job.frames,
      })
      await setJobBoordsId(jobId, storyboard.id, storyboard.url)
      await markJobComplete(jobId, job.frames.length)
      return {
        agent: 'boords',
        action: 'resume',
        success: true,
        url: storyboard.url,
        id: storyboard.id,
        message: `Resumed: created "${storyboard.name}" with ${job.frames.length} frame${
          job.frames.length === 1 ? '' : 's'
        }.`,
        data: {
          jobId,
          storyboardId: storyboard.id,
          storyboardName: storyboard.name,
          frameCount: job.frames.length,
        },
      }
    }

    // Storyboard exists but some frames are missing → append the rest.
    const remaining = job.frames.slice(job.lastFrameIndex)
    if (remaining.length === 0) {
      await markJobComplete(jobId, job.frames.length)
      return {
        agent: 'boords',
        action: 'resume',
        success: true,
        url: job.boordsUrl || undefined,
        id: job.boordsStoryboardId,
        message: 'Nothing left to resume — all frames are already in Boords.',
        data: { jobId, frameCount: job.frames.length },
      }
    }
    await appendFrames(job.boordsStoryboardId, remaining, job.lastFrameIndex)
    await advanceJobIndex(jobId, job.frames.length)
    await markJobComplete(jobId, job.frames.length)
    return {
      agent: 'boords',
      action: 'resume',
      success: true,
      url: job.boordsUrl || undefined,
      id: job.boordsStoryboardId,
      message: `Resumed: appended ${remaining.length} frame${remaining.length === 1 ? '' : 's'}.`,
      data: { jobId, frameCount: job.frames.length },
    }
  } catch (err: any) {
    await markJobFailed(jobId, err.message || String(err))
    return {
      agent: 'boords',
      action: 'resume',
      success: false,
      error: err.message || String(err),
      data: { jobId, hint: `Retry with: /storyboard resume ${jobId}` },
    }
  }
}

async function findProjects(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const query = (payload.query as string)?.toLowerCase() || ''
    const projects = await listProjects(100)
    const matches = query
      ? projects.filter((p) => p.name.toLowerCase().includes(query))
      : projects
    return {
      agent: 'boords',
      action: 'find_projects',
      success: true,
      message: `${matches.length} Boords project(s)${query ? ` matching "${query}"` : ''}`,
      data: { projects: matches },
    }
  } catch (err: any) {
    return { agent: 'boords', action: 'find_projects', success: false, error: err.message }
  }
}

async function findStoryboards(payload: Record<string, unknown>): Promise<AgentResult> {
  try {
    const projectId = (payload.projectId as string) || undefined
    const query = (payload.query as string)?.toLowerCase() || ''
    const storyboards = await listStoryboards(projectId, 100)
    const matches = query
      ? storyboards.filter((s) => s.name.toLowerCase().includes(query))
      : storyboards
    return {
      agent: 'boords',
      action: 'find_storyboards',
      success: true,
      message: `${matches.length} storyboard(s)${query ? ` matching "${query}"` : ''}`,
      data: { storyboards: matches },
    }
  } catch (err: any) {
    return { agent: 'boords', action: 'find_storyboards', success: false, error: err.message }
  }
}

// ─── Agent Definition ──────────────────────────────────────

export const boordsAgent: AgentDefinition = {
  id: 'boords',
  name: 'Boords Agent',
  domain: 'Boords (storyboards)',
  expertise:
    'Storyboards and visual scripts. Turn a script (pasted text, .docx, or .txt) into a Boords storyboard with one frame per beat — voiceover in the sound field, visuals in the action field. Auto-detects Audio/Visual tables; falls back to sentence split or AI scene extraction.',
  requiredEnvVars: ['BOORDS_API_KEY'],
  capabilities: [
    {
      action: 'provision',
      description:
        'Create a Boords storyboard from a script. Each line/sentence/scene becomes a frame with voiceover in the sound field and visuals in the action field. Supports blank mode for an empty placeholder storyboard.',
      inputDescription:
        'projectName (required, the storyboard title — also used as the Boords project name), script (the script text — required unless blank=true), blank (true for a placeholder storyboard with one empty frame), mode ("auto" | "sentence" | "table" | "ai"; defaults to auto which tries A/V table first then falls back to sentence split), aspectRatio ("16:9" | "9:16" | "1:1" | "4:5" | "21:9"; default 16:9), secondsPerFrame (number; default 5), videoStyle (free text e.g. "Realistic" / "Animated"), boordsProjectId (optional — drop this storyboard into an existing Boords project; omit to auto-create a fresh project)',
      mutates: true,
    },
    {
      action: 'find_projects',
      description: 'List Boords projects (the folder above storyboards)',
      inputDescription: 'query (optional name filter)',
      mutates: false,
    },
    {
      action: 'find_storyboards',
      description: 'List storyboards, optionally scoped to a Boords project',
      inputDescription: 'projectId (optional), query (optional name filter)',
      mutates: false,
    },
    {
      action: 'resume',
      description:
        'Resume a failed storyboard provision by job id. Loads the persisted frames and retries createStoryboard (or appendFrames if a partial storyboard already exists).',
      inputDescription: 'jobId (required, uuid from storyboard_jobs)',
      mutates: true,
    },
  ],
  handler: async (action, payload) => {
    switch (action) {
      case 'provision':
        return provision(payload)
      case 'find_projects':
        return findProjects(payload)
      case 'find_storyboards':
        return findStoryboards(payload)
      case 'resume':
        return resume(payload)
      default:
        return { agent: 'boords', action, success: false, error: `Unknown action: ${action}` }
    }
  },
}
