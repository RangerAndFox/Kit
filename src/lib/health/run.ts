/**
 * One call that produces the full health picture — integration probes plus
 * cron freshness. Shared by the /api/status route and the watchdog cron so
 * the page and the alerts can never disagree about what "healthy" means.
 */

import { runIntegrationProbes, checkCronFreshness } from './probes'
import { loadHeartbeats, getOrInitMonitorEpoch } from './state'
import type { CheckResult } from './diff'

export async function runAllChecks(): Promise<CheckResult[]> {
  // Startup grace anchors to a PERSISTENT epoch (first-ever watchdog run), not a
  // per-invocation timestamp — so a Vercel cold start cannot reset the grace and
  // hide an already-stale Railway worker. On error, epoch is null → no grace
  // (fail toward actionable), never a fresh resettable window.
  const [integrations, heartbeats, epoch] = await Promise.all([
    runIntegrationProbes(),
    loadHeartbeats().catch(() => ({})), // freshness is best-effort
    getOrInitMonitorEpoch().catch(() => null),
  ])
  return [...integrations, ...checkCronFreshness(heartbeats, new Date(), process.env, epoch ?? undefined)]
}
