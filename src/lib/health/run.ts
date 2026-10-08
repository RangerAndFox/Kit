/**
 * One call that produces the full health picture — integration probes plus
 * cron freshness. Shared by the /api/status route and the watchdog cron so
 * the page and the alerts can never disagree about what "healthy" means.
 */

import { runIntegrationProbes, checkCronFreshness } from './probes'
import { loadHeartbeats, getOrInitMonitorEpoch, registerCronSchedules } from './state'
import type { CheckResult } from './diff'
import { retryHealthIo } from './retry'

const dependencies = { runIntegrationProbes, checkCronFreshness, loadHeartbeats, getOrInitMonitorEpoch, registerCronSchedules }

/** Confirm a transient read failure with a fresh, independently bounded read.
 * Never substitute cached successes: two failures still mean unknown. */
export async function readHeartbeatsWithRetry<T>(read: () => Promise<T>,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 250))): Promise<T> {
  try { return await read() } catch {
    console.warn('[health-monitor] heartbeat read unavailable; confirming with one fresh read')
    await pause()
    return read()
  }
}

// Injected for failure-path tests; production always uses the same shared owners.
export async function runAllChecks(io = dependencies): Promise<CheckResult[]> {
  // Startup grace anchors to a PERSISTENT epoch (first-ever watchdog run), not a
  // per-invocation timestamp — so a Vercel cold start cannot reset the grace and
  // hide an already-stale Railway worker. On error, epoch is null → no grace
  // (fail toward actionable), never a fresh resettable window.
  const started = Date.now()
  const report = (stage: string, error: unknown) => {
    const message = error instanceof Error ? error.message : ''
    // No raw provider messages, credentials, URLs or payloads in diagnostics.
    const category = /abort|timeout|timed out/i.test(message) ? 'timeout'
      : /fetch|network|connect/i.test(message) ? 'network' : 'database_or_configuration'
    console.error('[health-monitor]', { stage, outcome: 'unavailable', category, elapsed_ms: Date.now() - started })
  }
  const [integrations, heartbeats, epoch, registered] = await Promise.all([
    io.runIntegrationProbes(),
    readHeartbeatsWithRetry(io.loadHeartbeats).catch(error => { report('heartbeat_read', error); return null }),
    io.getOrInitMonitorEpoch().catch(error => { report('epoch_read', error); return null }),
    retryHealthIo(() => io.registerCronSchedules('vercel')).then(() => true).catch(error => { report('configuration_write', error); return false }),
  ])
  // Always emit both check keys, including explicit recovery. A failed write
  // cannot prevent reading existing outcomes, and unknown is never healthy.
  const telemetry: CheckResult = { key: 'cron:telemetry', label: 'Cron monitoring', ok: heartbeats !== null,
    unknown: heartbeats === null,
    detail: heartbeats ? 'Heartbeat data available' : 'Heartbeat data unavailable; job outcomes unknown' }
  const configuration: CheckResult = { key: 'cron:configuration', label: 'Cron configuration', ok: registered,
    unknown: !registered,
    detail: registered ? 'Schedule registration current' : 'Schedule registration failed; existing recorded outcomes checked when available' }
  return [...integrations, telemetry, configuration,
    ...(heartbeats ? io.checkCronFreshness(heartbeats, new Date(), process.env, epoch ?? undefined) : [])]
}
