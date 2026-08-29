// @ts-nocheck
import { inngest } from '../inngest/client'
import { buildArchiveProgressCard } from './blocks'
import { prepareDropboxArchive, getDropboxSharedLink, listArchiveMedia, validateDropboxVideo } from './dropbox'
import { createBufferDrafts, createUnlistedVimeo, createWordpressDraft, invokeArchiveMediaWorker, prepareBehanceManifest } from './adapters'
import { finishArchiveStep, getArchiveJob, getArchiveStep, startArchiveStep, updateArchiveJob } from './store'

async function updateSlack(job: any): Promise<void> {
  if (!job.slack_channel_id || !job.slack_message_ts || !process.env.SLACK_BOT_TOKEN) return
  const card = buildArchiveProgressCard(job)
  const response = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: job.slack_channel_id, ts: job.slack_message_ts, text: card.text, blocks: card.blocks }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.ok) throw new Error(`Slack progress update failed: ${body.error || response.status}`)
}

async function progress(jobId: string, status: string, message: string, patch: Record<string, any> = {}): Promise<any> {
  const job = await updateArchiveJob(jobId, { status, progress: { message, at: new Date().toISOString() }, ...patch } as any)
  await updateSlack(job).catch((error) => console.warn('[archive] Slack progress update failed:', error.message))
  return job
}

async function durableStep(jobId: string, name: string, fn: () => Promise<any>): Promise<any> {
  const previous = await getArchiveStep(jobId, name)
  if (previous?.status === 'complete' || previous?.status === 'skipped') return previous.result
  await startArchiveStep(jobId, name)
  try {
    const result = await fn()
    await finishArchiveStep(jobId, name, 'complete', result)
    return result
  } catch (error: any) {
    await finishArchiveStep(jobId, name, 'failed', {}, error?.message || String(error))
    throw error
  }
}

async function optionalDestination(jobId: string, name: string, fn: () => Promise<any>): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    return { ok: true, result: await durableStep(jobId, name, fn) }
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) }
  }
}

export async function runArchiveJob(jobId: string): Promise<any> {
  let job = await getArchiveJob(jobId)
  if (!job) throw new Error(`Archive job ${jobId} not found.`)
  if (job.status === 'cancelled' || job.status === 'complete') return job
  if (!job.settings?.rightsConfirmed) throw new Error('Portfolio rights confirmation is missing.')

  const results = { ...(job.results || {}) }
  const failures: string[] = []
  try {
    await progress(jobId, 'validating', 'Validating the approved Dropbox source video…')
    const source = await durableStep(jobId, 'validate_source', () => validateDropboxVideo(job!.source_video_path))

    await progress(jobId, 'preparing_media', 'Creating the standardized Dropbox archive and copying the approved video…')
    const prepared = await durableStep(jobId, 'prepare_dropbox', async () => {
      const output = await prepareDropboxArchive(job!.project_snapshot, source)
      const folderUrl = await getDropboxSharedLink(output.folderPath)
      return { ...output, folderUrl }
    })
    results.dropbox = { status: 'prepared', folderPath: prepared.folderPath, folderUrl: prepared.folderUrl }
    job = await updateArchiveJob(jobId, { results } as any)

    let archiveMedia = prepared.media || []
    const mediaRequired = job.destinations.includes('wordpress') || job.destinations.includes('behance')
    let mediaReady = archiveMedia.length > 0 || !mediaRequired
    if (archiveMedia.length === 0 && mediaRequired) {
      const outcome = await optionalDestination(jobId, 'media_derivatives', () => invokeArchiveMediaWorker(job!, prepared.videoPath, prepared.folderPath))
      if (outcome.ok) {
        results.media = { status: 'generated', ...outcome.result }
        archiveMedia = await listArchiveMedia(prepared.folderPath)
        mediaReady = archiveMedia.length > 0
        if (!mediaReady) {
          failures.push('Media derivatives: the worker completed but no stills or GIFs were found')
          results.media = { status: 'failed', error: 'No generated media was found in Dropbox' }
        }
      } else {
        failures.push(`Media derivatives: ${outcome.error}`)
        results.media = { status: 'failed', error: outcome.error }
      }
    } else {
      results.media = { status: archiveMedia.length ? 'existing' : 'not_required', count: archiveMedia.length }
    }

    let vimeo: any = results.vimeo || null
    if (job.destinations.includes('vimeo')) {
      await progress(jobId, 'uploading_vimeo', 'Creating an unlisted Vimeo upload directly from Dropbox…', { results })
      const outcome = await optionalDestination(jobId, 'vimeo', () => createUnlistedVimeo(job!, prepared.videoPath, source.size))
      if (outcome.ok) { vimeo = outcome.result; results.vimeo = outcome.result }
      else { failures.push(`Vimeo: ${outcome.error}`); results.vimeo = { status: 'failed', error: outcome.error } }
    }

    if (job.destinations.includes('wordpress') && mediaReady && (!job.destinations.includes('vimeo') || vimeo?.id)) {
      await progress(jobId, 'creating_wordpress', 'Creating the WordPress portfolio draft…', { results })
      const outcome = await optionalDestination(jobId, 'wordpress', () => createWordpressDraft(job!, vimeo, archiveMedia))
      if (outcome.ok) results.wordpress = outcome.result
      else { failures.push(`WordPress: ${outcome.error}`); results.wordpress = { status: 'failed', error: outcome.error } }
    } else if (job.destinations.includes('wordpress')) {
      const reason = !mediaReady ? 'media derivatives must succeed first' : 'Vimeo upload must succeed first'
      failures.push(`WordPress: waiting because ${reason}`)
      results.wordpress = { status: 'blocked', error: reason }
    }

    if (job.destinations.includes('buffer')) {
      await progress(jobId, 'creating_buffer', 'Creating Buffer drafts…', { results })
      const outcome = await optionalDestination(jobId, 'buffer', () => createBufferDrafts(job!, vimeo))
      if (outcome.ok) results.buffer = outcome.result
      else { failures.push(`Buffer: ${outcome.error}`); results.buffer = { status: 'failed', error: outcome.error } }
    }

    if (job.destinations.includes('behance') && mediaReady) {
      await progress(jobId, 'preparing_behance', 'Preparing the Behance handoff package…', { results })
      results.behance = await durableStep(jobId, 'behance', async () => prepareBehanceManifest(job!, vimeo, archiveMedia, prepared.folderPath))
    } else if (job.destinations.includes('behance')) {
      failures.push('Behance: waiting for media derivatives')
      results.behance = { status: 'blocked', error: 'Media derivatives must succeed first' }
    }

    const finalStatus = failures.length ? 'partial' : 'complete'
    job = await updateArchiveJob(jobId, {
      status: finalStatus,
      results,
      error: failures.length ? failures.join(' | ') : null,
      progress: { message: failures.length ? 'Archive preparation finished with items requiring attention.' : 'Archive preparation is complete and ready for human review.' },
      completed_at: new Date().toISOString(),
    } as any)
    await updateSlack(job).catch(() => {})
    return job
  } catch (error: any) {
    job = await updateArchiveJob(jobId, {
      status: 'failed', results, error: error?.message || String(error),
      progress: { message: 'Archive preparation stopped before completion.' },
      completed_at: new Date().toISOString(),
    } as any)
    await updateSlack(job).catch(() => {})
    throw error
  }
}

export const archivePublisher = inngest.createFunction(
  {
    id: 'archive-publisher',
    name: 'Archive Publisher — private draft workflow',
    retries: 2,
    triggers: [{ event: 'archive/job.requested' }],
  },
  async ({ event, step }: any) => step.run('run-archive-job', () => runArchiveJob(event.data.job_id)),
)
