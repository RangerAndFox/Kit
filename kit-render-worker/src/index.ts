// @ts-nocheck
/**
 * Render worker entry point.
 *
 * Starts heartbeat loop, then polls for claimable jobs forever.
 */

import { config } from './config'
import { startHeartbeat, sendHeartbeat, getCurrentJob } from './heartbeat'
import { tryClaimJob } from './job-claimer'
import { processJob } from './job-processor'

console.log('═══════════════════════════════════════════════════════')
console.log(' Kit Render Worker')
console.log(`  Hostname:   ${config.hostname}`)
console.log(`  Role:       ${config.role} (priority ${config.priority})`)
console.log(`  Dropbox:    ${config.dropboxSyncPath || '(not set)'}`)
console.log(`  FFmpeg:     ${config.ffmpegPath}`)
console.log(`  CPU max:    ${config.cpuThreshold}%`)
console.log(`  Min disk:   ${config.minDiskFreeGb} GB`)
console.log('═══════════════════════════════════════════════════════')

async function main(): Promise<void> {
  await sendHeartbeat()
  startHeartbeat()

  const pollInterval = config.role === 'primary' ? config.pollIntervalMs : Math.max(config.pollIntervalMs, 15000)
  console.log(`[worker] polling for jobs every ${pollInterval}ms`)

  while (true) {
    try {
      if (!getCurrentJob()) {
        const job = await tryClaimJob()
        if (job) {
          console.log(`[worker] claimed job ${job.id}`)
          await processJob(job)
        }
      }
    } catch (err: any) {
      console.error('[worker] loop error:', err.message || err)
    }
    await sleep(pollInterval)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('[worker] fatal:', err)
  process.exit(1)
})
