/**
 * One call that produces the full health picture — integration probes plus
 * cron freshness. Shared by the /api/status route and the watchdog cron so
 * the page and the alerts can never disagree about what "healthy" means.
 */

import { runIntegrationProbes, checkCronFreshness } from './probes'
import { loadHeartbeats, getOrInitMonitorEpoch, registerCronSchedules } from './state'
import type { CheckResult } from './diff'

const dependencies = { runIntegrationProbes, checkCronFreshness, loadHeartbeats, getOrInitMonitorEpoch, registerCronSchedules }

// Injected for failure-path tests; production always uses the same shared owners.
export async function runAllChecks(io = dependencies): Promise<CheckResult[]> {
  // Startup grace anchors to a PERSISTENT epoch (first-ever watchdog run), not a
  // per-invocation timestamp — so a Vercel cold start cannot reset the grace and
  // hide an already-stale Railway worker. On error, epoch is null → no grace
  // (fail toward actionable), never a fresh resettable window.
  const report = (stage: string) => { console.error('[health-monitor]', { stage, outcome: 'unavailable' }) }
  const [integrations, heartbeats, epoch, registered] = await Promise.all([
    io.runIntegrationProbes(),
    io.loadHeartbeats().catch(() => { report('heartbeat_read'); return null }),
    io.getOrInitMonitorEpoch().catch(() => { report('epoch_read'); return null }),
    io.registerCronSchedules('vercel').then(() => true).catch(() => { report('configuration_write'); return false }),
  ])
  // Always emit both check keys, including explicit recovery. A failed write
  // cannot prevent reading existing outcomes, and unknown is never healthy.
  const telemetry: CheckResult = { key: 'cron:telemetry', label: 'Cron monitoring', ok: heartbeats !== null,
    detail: heartbeats ? 'Heartbeat data available' : 'Heartbeat data unavailable; job outcomes unknown' }
  const configuration: CheckResult = { key: 'cron:configuration', label: 'Cron configuration', ok: registered,
    detail: registered ? 'Schedule registration current' : 'Schedule registration failed; existing recorded outcomes checked when available' }
  return [...integrations, telemetry, configuration,
    ...(heartbeats ? io.checkCronFreshness(heartbeats, new Date(), process.env, epoch ?? undefined) : [])]
}
