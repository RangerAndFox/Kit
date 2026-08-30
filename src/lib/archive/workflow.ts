// @ts-nocheck
import crypto from 'node:crypto'
import { inngest } from '../inngest/client'
import { buildArchiveProgressCard } from './blocks'
import { prepareDropboxArchive, getDropboxSharedLink, listArchiveMedia, validateDropboxVideo } from './dropbox'
import { configuredBufferChannels, createBufferDraft, createUnlistedVimeo, createWordpressDraft, invokeArchiveMediaWorker, prepareBehanceManifest } from './adapters'
import { acquireArchiveJobLease, finishArchiveStep, getArchiveJob, listRecoverableArchiveJobs, startArchiveStep, updateClaimedArchiveJob } from './store'

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

async function progress(jobId: string, claimToken: string, status: string, message: string, patch: Record<string, any> = {}): Promise<any> {
  const job = await updateClaimedArchiveJob(jobId, claimToken, { status, progress: { message, at: new Date().toISOString() }, ...patch } as any)
  await updateSlack(job).catch((error) => console.warn('[archive] Slack progress update failed:', error.message))
  return job
}

async function durableStep(jobId: string, workerId: string, name: string, fn: () => Promise<any>): Promise<any> {
  const claimed = await startArchiveStep(jobId, name, workerId)
  if (!claimed) throw new Error(`archive step ${name} is already owned by another worker`)
  if (claimed.status === 'complete' || claimed.status === 'skipped') return claimed.result
  const claimToken = claimed.claim_token
  if (!claimToken) throw new Error(`archive step ${name} returned no claim token`)
  try {
    const result = await fn()
    await finishArchiveStep(jobId, name, claimToken, 'complete', result)
    return result
  } catch (error: any) {
    await finishArchiveStep(jobId, name, claimToken, 'failed', {}, error?.message || String(error))
    throw error
  }
}

async function optionalDestination(jobId: string, workerId: string, name: string, fn: () => Promise<any>): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    return { ok: true, result: await durableStep(jobId, workerId, name, fn) }
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) }
  }
}

export async function runArchiveJob(jobId: string): Promise<any> {
  const workerId = `archive:${process.pid}:${crypto.randomUUID()}`
  let job = await getArchiveJob(jobId)
  if (!job) throw new Error(`Archive job ${jobId} not found.`)
  if (job.status === 'cancelled' || job.status === 'complete') return job
  if (!job.settings?.rightsConfirmed) throw new Error('Portfolio rights confirmation is missing.')
  const leased = await acquireArchiveJobLease(jobId, workerId)
  if (!leased) return getArchiveJob(jobId)
  job = leased
  const jobClaimToken = job.claim_token
  if (!jobClaimToken) throw new Error('Archive job lease returned no claim token.')

  const results = { ...(job.results || {}) }
  const failures: string[] = []
  try {
    await progress(jobId, jobClaimToken, 'validating', 'Validating the approved Dropbox source video…')
    const source = await durableStep(jobId, workerId, 'validate_source', () => validateDropboxVideo(job!.source_video_path))

    await progress(jobId, jobClaimToken, 'preparing_media', 'Creating the standardized Dropbox archive and copying the approved video…')
    const prepared = await durableStep(jobId, workerId, 'prepare_dropbox', async () => {
      const output = await prepareDropboxArchive(job!.project_snapshot, source)
      const folderUrl = await getDropboxSharedLink(output.folderPath)
      return { ...output, folderUrl }
    })
    results.dropbox = { status: 'prepared', folderPath: prepared.folderPath, folderUrl: prepared.folderUrl }
    job = await updateClaimedArchiveJob(jobId, jobClaimToken, { results } as any)

    let archiveMedia = prepared.media || []
    const mediaRequired = job.destinations.includes('wordpress') || job.destinations.includes('behance')
    let mediaReady = archiveMedia.length > 0 || !mediaRequired
    if (archiveMedia.length === 0 && mediaRequired) {
      const outcome = await optionalDestination(jobId, workerId, 'media_derivatives', () => invokeArchiveMediaWorker(job!, prepared.videoPath, prepared.folderPath))
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
      await progress(jobId, jobClaimToken, 'uploading_vimeo', 'Creating an unlisted Vimeo upload directly from Dropbox…', { results })
      const outcome = await optionalDestination(jobId, workerId, 'vimeo', () => createUnlistedVimeo(job!, prepared.videoPath, source.size))
      if (outcome.ok) { vimeo = outcome.result; results.vimeo = outcome.result }
      else { failures.push(`Vimeo: ${outcome.error}`); results.vimeo = { status: 'failed', error: outcome.error } }
    }

    if (job.destinations.includes('wordpress') && mediaReady && (!job.destinations.includes('vimeo') || vimeo?.id)) {
      await progress(jobId, jobClaimToken, 'creating_wordpress', 'Creating the WordPress portfolio draft…', { results })
      const outcome = await optionalDestination(jobId, workerId, 'wordpress', () => createWordpressDraft(job!, vimeo, archiveMedia))
      if (outcome.ok) results.wordpress = outcome.result
      else { failures.push(`WordPress: ${outcome.error}`); results.wordpress = { status: 'failed', error: outcome.error } }
    } else if (job.destinations.includes('wordpress')) {
      const reason = !mediaReady ? 'media derivatives must succeed first' : 'Vimeo upload must succeed first'
      failures.push(`WordPress: waiting because ${reason}`)
      results.wordpress = { status: 'blocked', error: reason }
    }

    if (job.destinations.includes('buffer')) {
      await progress(jobId, jobClaimToken, 'creating_buffer', 'Creating Buffer drafts…', { results })
      const channels = configuredBufferChannels()
      if (!channels.length) {
        failures.push('Buffer: no configured LinkedIn or Instagram channel')
        results.buffer = { status: 'failed', error: 'No configured channel' }
      } else {
        const drafts = []
        for (const channel of channels) {
          const outcome = await optionalDestination(jobId, workerId, `buffer_${channel.name}`, () => createBufferDraft(job!, vimeo, channel))
          if (outcome.ok) drafts.push(outcome.result)
          else failures.push(`Buffer ${channel.name}: ${outcome.error}`)
        }
        results.buffer = {
          status: drafts.length === channels.length ? 'draft' : 'partial',
          drafts,
          note: vimeo?.url ? `Attach the approved video manually: ${vimeo.url}` : undefined,
        }
      }
    }

    if (job.destinations.includes('behance') && mediaReady) {
      await progress(jobId, jobClaimToken, 'preparing_behance', 'Preparing the Behance handoff package…', { results })
      results.behance = await durableStep(jobId, workerId, 'behance', async () => prepareBehanceManifest(job!, vimeo, archiveMedia, prepared.folderPath))
    } else if (job.destinations.includes('behance')) {
      failures.push('Behance: waiting for media derivatives')
      results.behance = { status: 'blocked', error: 'Media derivatives must succeed first' }
    }

    const finalStatus = failures.length ? 'partial' : 'complete'
    job = await updateClaimedArchiveJob(jobId, jobClaimToken, {
      status: finalStatus,
      results,
      error: failures.length ? failures.join(' | ') : null,
      progress: { message: failures.length ? 'Archive preparation finished with items requiring attention.' : 'Archive preparation is complete and ready for human review.' },
      completed_at: new Date().toISOString(),
      claim_token: null,
      claimed_by: null,
      claimed_at: null,
    } as any)
    await updateSlack(job).catch(() => {})
    return job
  } catch (error: any) {
    job = await updateClaimedArchiveJob(jobId, jobClaimToken, {
      status: 'failed', results, error: error?.message || String(error),
      progress: { message: 'Archive preparation stopped before completion.' },
      completed_at: new Date().toISOString(),
      claim_token: null,
      claimed_by: null,
      claimed_at: null,
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

export const archiveRecovery = inngest.createFunction(
  {
    id: 'archive-recovery',
    name: 'Archive Publisher — stale lease recovery',
    retries: 1,
    triggers: [{ cron: '17 * * * *' }],
  },
  async ({ step }: any) => {
    const jobs = await step.run('find-recoverable-archive-jobs', () => listRecoverableArchiveJobs())
    if (!jobs.length) return { queued: 0 }
    await step.sendEvent('requeue-stale-archive-jobs', jobs.map((job: ArchiveJob) => ({
      name: 'archive/job.requested',
      data: { job_id: job.id, recovery: true },
    })))
    return { queued: jobs.length }
  },
)
