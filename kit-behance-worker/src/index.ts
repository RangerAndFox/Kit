import { buildBehanceDraft, BehanceLoginRequiredError, launchBehanceContext } from './behance.js'
import { config } from './config.js'
import { claimNextJob, heartbeat, pulseJob, updateJob } from './store.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('Kit Behance Worker')
console.log(`Worker: ${config.displayName} (${config.workerId})`)
console.log('Safety: draft save only; publish controls and publish mutations are blocked')

const context = await launchBehanceContext()
let activeJobId: string | null = null
let workerState: 'idle' | 'working' | 'needs_login' | 'error' = 'idle'
let lastError: string | null = null

const heartbeats = setInterval(() => {
  void heartbeat(workerState, activeJobId, lastError).catch((error) => console.error('[heartbeat]', error.message))
  if (activeJobId) void pulseJob(activeJobId).catch((error) => console.error('[job-heartbeat]', error.message))
}, config.heartbeatIntervalMs)

process.once('SIGINT', async () => { clearInterval(heartbeats); await context.close(); process.exit(0) })
process.once('SIGTERM', async () => { clearInterval(heartbeats); await context.close(); process.exit(0) })

while (true) {
  try {
    const job = await claimNextJob()
    if (!job) {
      workerState = 'idle'; activeJobId = null; lastError = null
      await heartbeat('idle')
      await sleep(config.pollIntervalMs)
      continue
    }
    activeJobId = job.id; workerState = 'working'; lastError = null
    await heartbeat('working', job.id)
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
    lastError = message
    workerState = error instanceof BehanceLoginRequiredError ? 'needs_login' : 'error'
    console.error('[worker]', message)
    if (activeJobId) await updateJob(activeJobId, error instanceof BehanceLoginRequiredError ? 'retryable' : 'failed', { error: message }).catch(() => {})
    await heartbeat(workerState, activeJobId, message).catch(() => {})
    await sleep(Math.max(config.pollIntervalMs, 15000))
  } finally {
    activeJobId = null
  }
}
