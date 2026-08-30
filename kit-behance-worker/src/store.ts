import { workerRequest } from './api.js'
import type { BehanceDraftJob, BehanceJobStatus, ElevenLabsJobStatus, ElevenLabsStudioJob } from './types.js'

export async function heartbeat(status: 'idle' | 'working' | 'needs_login' | 'error', jobId?: string | null, error?: string | null, browserVersion?: string | null): Promise<void> {
  await workerRequest('behance.heartbeat', { status, jobId, error, browserVersion })
}

export async function claimNextJob(): Promise<BehanceDraftJob | null> {
  return (await workerRequest<{ ok: true; job: BehanceDraftJob | null }>('behance.claim')).job
}

export async function updateJob(job: Pick<BehanceDraftJob, 'id' | 'claimed_at'>, status: BehanceJobStatus, patch: Record<string, unknown> = {}): Promise<void> {
  await workerRequest('behance.update', { jobId: job.id, claimedAt: job.claimed_at, status, patch })
}

export async function pulseJob(job: Pick<BehanceDraftJob, 'id' | 'claimed_at'>): Promise<void> {
  await workerRequest('behance.pulse', { jobId: job.id, claimedAt: job.claimed_at })
}

export async function elevenLabsHeartbeat(status: 'idle' | 'working' | 'needs_login' | 'error', jobId?: string | null, error?: string | null, browserVersion?: string | null): Promise<void> {
  await workerRequest('elevenlabs.heartbeat', { status, jobId, error, browserVersion })
}

export async function claimNextElevenLabsJob(): Promise<ElevenLabsStudioJob | null> {
  return (await workerRequest<{ ok: true; job: ElevenLabsStudioJob | null }>('elevenlabs.claim')).job
}

export async function updateElevenLabsJob(job: Pick<ElevenLabsStudioJob, 'id' | 'claimed_at'>, status: ElevenLabsJobStatus, patch: Record<string, unknown> = {}): Promise<void> {
  await workerRequest('elevenlabs.update', { jobId: job.id, claimedAt: job.claimed_at, status, patch })
}

export async function pulseElevenLabsJob(job: Pick<ElevenLabsStudioJob, 'id' | 'claimed_at'>): Promise<void> {
  await workerRequest('elevenlabs.pulse', { jobId: job.id, claimedAt: job.claimed_at })
}

export async function completeStoryboardElevenLabs(job: Pick<ElevenLabsStudioJob, 'id' | 'claimed_at'>, projectId: string, url: string): Promise<void> {
  await workerRequest('elevenlabs.complete', { jobId: job.id, claimedAt: job.claimed_at, projectId, url })
}

export async function failStoryboardElevenLabs(
  job: Pick<ElevenLabsStudioJob, 'id' | 'storyboard_job_id' | 'claimed_at'>,
  errorMessage: string,
): Promise<void> {
  await workerRequest('elevenlabs.fail_storyboard', {
    jobId: job.id,
    storyboardJobId: job.storyboard_job_id,
    claimedAt: job.claimed_at,
    error: errorMessage,
  })
}
