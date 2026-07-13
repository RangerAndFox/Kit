/**
 * Health-state transition logic (pure — unit-tested).
 *
 * The watchdog cron runs every ~10 min. We only want to alert on a *change*
 * of state, not every tick — otherwise a persistent outage spams the channel
 * every 10 minutes. `diffHealth` compares the previously-recorded status per
 * check against the latest probe results and returns just the flips:
 *   - `downed`     — was up (or unknown) and is now failing → fire an alert
 *   - `recovered`  — was down and is now passing → fire an "all clear"
 * Everything still-up or still-down is intentionally silent.
 */

export type Status = 'up' | 'down'

export interface CheckResult {
  key: string
  label: string
  ok: boolean
  /** Short human detail — error message when down, latency/summary when up. */
  detail?: string
}

export interface HealthDiff {
  downed: CheckResult[]
  recovered: CheckResult[]
}

/**
 * @param prev  last recorded status per check key ('up' | 'down').
 *              A key absent from `prev` is treated as previously-up, so a
 *              brand-new check that's already failing still alerts, and a
 *              new check that's healthy stays silent.
 */
export function diffHealth(
  prev: Record<string, Status>,
  curr: CheckResult[],
): HealthDiff {
  const downed: CheckResult[] = []
  const recovered: CheckResult[] = []
  for (const r of curr) {
    const was: Status = prev[r.key] ?? 'up'
    if (!r.ok && was !== 'down') downed.push(r)
    else if (r.ok && was === 'down') recovered.push(r)
  }
  return { downed, recovered }
}
