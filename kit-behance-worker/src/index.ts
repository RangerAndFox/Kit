import { behanceBrowserVersion, buildBehanceDraft, BehanceLoginRequiredError, isBehanceSignedIn, launchBehanceContext } from './behance.js'
import { buildElevenLabsDraft, ElevenLabsLoginRequiredError, isElevenLabsSignedIn } from './elevenlabs.js'
import { deleteFrameioProjectInBrowser, FrameioLoginRequiredError, isFrameioSignedIn } from './frameio.js'
import { config } from './config.js'
import { runCancellable } from './cancellable.js'
import {
  claimNextElevenLabsJob,
  claimNextJob,
  completeStoryboardElevenLabs,
  elevenLabsHeartbeat,
  failStoryboardElevenLabs,
  claimNextFrameioDeletion,
  frameioHeartbeat,
  heartbeat,
  pulseElevenLabsJob,
  pulseJob,
  pulseFrameioDeletion,
  updateElevenLabsJob,
  updateJob,
  updateFrameioDeletion,
} from './store.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('Kit Studio Browser Worker')
console.log(`Worker: ${config.displayName} (${config.workerId})`)
console.log('Safety: private drafts only; publish, share, export, and ElevenLabs generation controls are blocked')
console.log('Frame.io project deletion runs only for jobs created by Kit after founder/admin typed confirmation')

const context = await launchBehanceContext()
const browserVersion = await behanceBrowserVersion(context)
let behanceJobId: string | null = null
let elevenLabsJobId: string | null = null
let frameioJobId: string | null = null
let behanceClaim: { id: string; claimed_at: string | null } | null = null
let elevenLabsClaim: { id: string; claimed_at: string | null } | null = null
let frameioClaim: { id: string; claimed_at: string | null } | null = null
let behanceAvailable = await isBehanceSignedIn(context)
let elevenLabsAvailable = await isElevenLabsSignedIn(context)
let frameioAvailable = await isFrameioSignedIn(context).catch((error: any) => {
  console.error('[frameio-login-check]', error?.message || String(error))
  return false
})

await heartbeat(behanceAvailable ? 'idle' : 'needs_login', null, behanceAvailable ? null : 'The dedicated browser is signed out of Behance.', browserVersion)
await elevenLabsHeartbeat(elevenLabsAvailable ? 'idle' : 'needs_login', null, elevenLabsAvailable ? null : 'The dedicated browser is signed out of ElevenLabs.', browserVersion)
await frameioHeartbeat(frameioAvailable ? 'idle' : 'needs_login', null, frameioAvailable ? null : 'The dedicated browser is signed out of Frame.io.', browserVersion)

const heartbeats = setInterval(() => {
  void heartbeat(behanceAvailable ? (behanceJobId ? 'working' : 'idle') : 'needs_login', behanceJobId, null, browserVersion)
    .catch((error) => console.error('[behance-heartbeat]', error.message))
  void elevenLabsHeartbeat(elevenLabsAvailable ? (elevenLabsJobId ? 'working' : 'idle') : 'needs_login', elevenLabsJobId, null, browserVersion)
    .catch((error) => console.error('[elevenlabs-heartbeat]', error.message))
  void frameioHeartbeat(frameioAvailable ? (frameioJobId ? 'working' : 'idle') : 'needs_login', frameioJobId, null, browserVersion)
    .catch((error) => console.error('[frameio-heartbeat]', error.message))
  if (behanceClaim) void pulseJob(behanceClaim).catch((error) => console.error('[behance-job-heartbeat]', error.message))
  if (elevenLabsClaim) void pulseElevenLabsJob(elevenLabsClaim).catch((error) => console.error('[elevenlabs-job-heartbeat]', error.message))
  if (frameioClaim) void pulseFrameioDeletion(frameioClaim).catch((error) => console.error('[frameio-job-heartbeat]', error.message))
}, config.heartbeatIntervalMs)

process.once('SIGINT', async () => { clearInterval(heartbeats); await context.close(); process.exit(0) })
process.once('SIGTERM', async () => { clearInterval(heartbeats); await context.close(); process.exit(0) })

async function processBehance(): Promise<boolean> {
  if (!behanceAvailable) return false
  const job = await claimNextJob()
  if (!job) return false
  behanceJobId = job.id
  behanceClaim = job
  await heartbeat('working', job.id, null, browserVersion)
  try {
    const result = await runCancellable(
      (signal) => buildBehanceDraft(context, job, signal),
      config.jobTimeoutMs,
      `Behance draft exceeded ${config.jobTimeoutMs / 60000} minutes.`,
    )
    await updateJob(job, 'awaiting_review', {
      draft_url: result.draftUrl,
      proof_dropbox_path: result.proofPath || null,
      proof_url: result.proofUrl,
      error: null,
    })
  } catch (error: any) {
    const message = error?.message || String(error)
    console.error('[behance]', message)
    if (error instanceof BehanceLoginRequiredError) behanceAvailable = false
    await updateJob(job, error instanceof BehanceLoginRequiredError ? 'retryable' : 'failed', { error: message }).catch(() => {})
    await heartbeat(behanceAvailable ? 'error' : 'needs_login', job.id, message, browserVersion).catch(() => {})
  } finally {
    behanceJobId = null
    behanceClaim = null
  }
  return true
}

async function processElevenLabs(): Promise<boolean> {
  if (!elevenLabsAvailable) return false
  const job = await claimNextElevenLabsJob()
  if (!job) return false
  elevenLabsJobId = job.id
  elevenLabsClaim = job
  await elevenLabsHeartbeat('working', job.id, null, browserVersion)
  try {
    const result = await runCancellable(
      (signal) => buildElevenLabsDraft(context, job, signal),
      config.jobTimeoutMs,
      `ElevenLabs draft exceeded ${config.jobTimeoutMs / 60000} minutes.`,
    )
    await completeStoryboardElevenLabs(job, result.projectId, result.url)
  } catch (error: any) {
    const message = error?.message || String(error)
    console.error('[elevenlabs]', message)
    const needsLogin = error instanceof ElevenLabsLoginRequiredError
    if (needsLogin) elevenLabsAvailable = false
    const retry = needsLogin || job.attempt < 3
    let failureOwned = false
    try {
      await updateElevenLabsJob(job, retry ? 'retryable' : 'failed', { error: message })
      failureOwned = true
    } catch {}
    if (!retry && failureOwned) await failStoryboardElevenLabs(job, message).catch(() => {})
    await elevenLabsHeartbeat(needsLogin ? 'needs_login' : 'error', job.id, message, browserVersion).catch(() => {})
  } finally {
    elevenLabsJobId = null
    elevenLabsClaim = null
  }
  return true
}

async function processFrameioDeletion(): Promise<boolean> {
  if (!frameioAvailable) return false
  const job = await claimNextFrameioDeletion()
  if (!job) return false
  frameioJobId = job.id
  frameioClaim = job
  await frameioHeartbeat('working', job.id, null, browserVersion)
  try {
    await runCancellable(
      (signal) => deleteFrameioProjectInBrowser(context, job, signal),
      Math.min(config.jobTimeoutMs, 180_000),
      'Frame.io project deletion exceeded three minutes.',
    )
  } catch (error: any) {
    const message = error?.message || String(error)
    console.error('[frameio]', message)
    const needsLogin = error instanceof FrameioLoginRequiredError
    if (needsLogin) frameioAvailable = false
    const retry = needsLogin || job.attempt < 3
    await updateFrameioDeletion(job, retry ? 'retryable' : 'failed', { error: message }).catch(() => {})
    await frameioHeartbeat(needsLogin ? 'needs_login' : 'error', job.id, message, browserVersion).catch(() => {})
  } finally {
    frameioJobId = null
    frameioClaim = null
  }
  return true
}

while (true) {
  try {
    const didFrameio = await processFrameioDeletion()
    const didBehance = await processBehance()
    const didElevenLabs = await processElevenLabs()
    if (!didFrameio && !didBehance && !didElevenLabs) await sleep(config.pollIntervalMs)
  } catch (error: any) {
    console.error('[worker]', error?.message || String(error))
    await sleep(Math.max(config.pollIntervalMs, 15_000))
  }
}
