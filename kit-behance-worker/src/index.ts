import { behanceBrowserVersion, buildBehanceDraft, BehanceLoginRequiredError, isBehanceSignedIn, launchBehanceContext } from './behance.js'
import { buildElevenLabsDraft, ElevenLabsLoginRequiredError, isElevenLabsSignedIn } from './elevenlabs.js'
import { config } from './config.js'
import {
  claimNextElevenLabsJob,
  claimNextJob,
  completeStoryboardElevenLabs,
  elevenLabsHeartbeat,
  failStoryboardElevenLabs,
  heartbeat,
  pulseElevenLabsJob,
  pulseJob,
  updateElevenLabsJob,
  updateJob,
} from './store.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('Kit Studio Browser Worker')
console.log(`Worker: ${config.displayName} (${config.workerId})`)
console.log('Safety: private drafts only; publish, share, export, and ElevenLabs generation controls are blocked')

const context = await launchBehanceContext()
const browserVersion = await behanceBrowserVersion(context)
let behanceJobId: string | null = null
let elevenLabsJobId: string | null = null
let behanceAvailable = await isBehanceSignedIn(context)
let elevenLabsAvailable = await isElevenLabsSignedIn(context)

await heartbeat(behanceAvailable ? 'idle' : 'needs_login', null, behanceAvailable ? null : 'The dedicated browser is signed out of Behance.', browserVersion)
await elevenLabsHeartbeat(elevenLabsAvailable ? 'idle' : 'needs_login', null, elevenLabsAvailable ? null : 'The dedicated browser is signed out of ElevenLabs.', browserVersion)

const heartbeats = setInterval(() => {
  void heartbeat(behanceAvailable ? (behanceJobId ? 'working' : 'idle') : 'needs_login', behanceJobId, null, browserVersion)
    .catch((error) => console.error('[behance-heartbeat]', error.message))
  void elevenLabsHeartbeat(elevenLabsAvailable ? (elevenLabsJobId ? 'working' : 'idle') : 'needs_login', elevenLabsJobId, null, browserVersion)
    .catch((error) => console.error('[elevenlabs-heartbeat]', error.message))
  if (behanceJobId) void pulseJob(behanceJobId).catch((error) => console.error('[behance-job-heartbeat]', error.message))
  if (elevenLabsJobId) void pulseElevenLabsJob(elevenLabsJobId).catch((error) => console.error('[elevenlabs-job-heartbeat]', error.message))
}, config.heartbeatIntervalMs)

process.once('SIGINT', async () => { clearInterval(heartbeats); await context.close(); process.exit(0) })
process.once('SIGTERM', async () => { clearInterval(heartbeats); await context.close(); process.exit(0) })

async function processBehance(): Promise<boolean> {
  if (!behanceAvailable) return false
  const job = await claimNextJob()
  if (!job) return false
  behanceJobId = job.id
  await heartbeat('working', job.id, null, browserVersion)
  try {
    const result = await Promise.race([
      buildBehanceDraft(context, job),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Behance draft exceeded ${config.jobTimeoutMs / 60000} minutes.`)), config.jobTimeoutMs)),
    ])
    await updateJob(job.id, 'awaiting_review', {
      draft_url: result.draftUrl,
      proof_dropbox_path: result.proofPath || null,
      proof_url: result.proofUrl,
      error: null,
    })
  } catch (error: any) {
    const message = error?.message || String(error)
    console.error('[behance]', message)
    if (error instanceof BehanceLoginRequiredError) behanceAvailable = false
    await updateJob(job.id, error instanceof BehanceLoginRequiredError ? 'retryable' : 'failed', { error: message }).catch(() => {})
    await heartbeat(behanceAvailable ? 'error' : 'needs_login', job.id, message, browserVersion).catch(() => {})
  } finally {
    behanceJobId = null
  }
  return true
}

async function processElevenLabs(): Promise<boolean> {
  if (!elevenLabsAvailable) return false
  const job = await claimNextElevenLabsJob()
  if (!job) return false
  elevenLabsJobId = job.id
  await elevenLabsHeartbeat('working', job.id, null, browserVersion)
  try {
    const result = await Promise.race([
      buildElevenLabsDraft(context, job),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`ElevenLabs draft exceeded ${config.jobTimeoutMs / 60000} minutes.`)), config.jobTimeoutMs)),
    ])
    await completeStoryboardElevenLabs(job.storyboard_job_id, result.projectId, result.url)
    await updateElevenLabsJob(job.id, 'complete', {
      studio_project_id: result.projectId,
      studio_url: result.url,
      error: null,
    })
  } catch (error: any) {
    const message = error?.message || String(error)
    console.error('[elevenlabs]', message)
    const needsLogin = error instanceof ElevenLabsLoginRequiredError
    if (needsLogin) elevenLabsAvailable = false
    const retry = needsLogin || job.attempt < 3
    await updateElevenLabsJob(job.id, retry ? 'retryable' : 'failed', { error: message }).catch(() => {})
    if (!retry) await failStoryboardElevenLabs(job.storyboard_job_id, message).catch(() => {})
    await elevenLabsHeartbeat(needsLogin ? 'needs_login' : 'error', job.id, message, browserVersion).catch(() => {})
  } finally {
    elevenLabsJobId = null
  }
  return true
}

while (true) {
  try {
    const didBehance = await processBehance()
    const didElevenLabs = await processElevenLabs()
    if (!didBehance && !didElevenLabs) await sleep(config.pollIntervalMs)
  } catch (error: any) {
    console.error('[worker]', error?.message || String(error))
    await sleep(Math.max(config.pollIntervalMs, 15_000))
  }
}
