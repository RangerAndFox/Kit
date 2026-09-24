/**
 * One call that produces the full health picture — integration probes plus
 * cron freshness. Shared by the /api/status route and the watchdog cron so
 * the page and the alerts can never disagree about what "healthy" means.
 */

import { runIntegrationProbes, checkCronFreshness } from './probes'
import { loadHeartbeats } from './state'
import type { CheckResult } from './diff'

// Watchdog process start — anchors the startup grace so a cold start / fresh
// deploy doesn't red a cron that simply hasn't stamped its first heartbeat yet.
const BOOT_AT = new Date()

export async function runAllChecks(): Promise<CheckResult[]> {
  const [integrations, heartbeats] = await Promise.all([
    runIntegrationProbes(),
    loadHeartbeats().catch(() => ({})), // freshness is best-effort
  ])
  return [...integrations, ...checkCronFreshness(heartbeats, new Date(), process.env, BOOT_AT)]
}
