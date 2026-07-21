/**
 * Durable per-service provisioning fan-out (Railway-owned).
 *
 * Provisioning calls several external services (Dropbox, Frame.io, Harvest,
 * Slack, …). Without a durable ledger a Railway restart mid-provision re-ran
 * EVERY service. This orchestrator memoizes each service's outcome in
 * `project_provisioning_steps` (keyed by project_id + service), so a resume runs
 * ONLY the services that have not reached 'done' and reuses the stored result
 * for the rest — recurring work scales with new activity, not total history
 * (invariant 8/9).
 *
 * Ordering is preserved by PHASES: phase groups run sequentially, services
 * within a group run in parallel, and each phase is a function of the results
 * accumulated so far — so a later phase (e.g. Slack, which needs the Dropbox /
 * Frame.io URLs) sees earlier results whether they were just produced OR
 * resumed from the ledger.
 *
 * Between phases it heartbeats the lease (renew). If the lease was lost (a
 * newer holder reclaimed it) it stops before running more work — cooperative
 * fencing, so a stale worker never double-provisions.
 *
 * Pure + injected (StepLedger) so it is unit-tested with fakes, not live.
 */

export interface StepResult {
  service?: string
  success?: boolean
  error?: string
  [k: string]: unknown
}

export interface PersistedStep {
  service: string
  status: string
  result: Record<string, unknown> | null
}

export interface StepLedger {
  getSteps(projectId: string): Promise<PersistedStep[]>
  markStep(
    projectId: string,
    service: string,
    patch: {
      status?: 'running' | 'done' | 'failed'
      result?: Record<string, unknown> | null
      error?: string | null
      attempts?: number
    },
  ): Promise<void>
  /**
   * Ownership check + heartbeat, verified IMMEDIATELY BEFORE each phase's
   * external writes. It is a compare-and-set on the exact lease holder (see
   * renewCreationRequestLease), so it returns false the instant a newer holder
   * reclaimed the lease — the runner then stops before dispatching any more
   * external work. This is the enforced fence: a stale worker cannot start
   * another write after losing ownership.
   */
  renew?: () => Promise<boolean>
}

/** A phase: given results so far, the services to run (in parallel) this phase. */
export type PhasePlan = (
  accumulated: Record<string, StepResult>,
) => Array<{ service: string; run: () => Promise<StepResult> }>

export interface DurableProvisioningResult {
  /** Merged results (resumed + freshly run), keyed by service. */
  results: Record<string, StepResult>
  /** Services skipped because a prior run already completed them. */
  resumed: string[]
  /** Services executed this pass. */
  ran: string[]
  /** True when a phase boundary detected the lease was lost and stopped early. */
  abortedLostLease: boolean
}

/**
 * A soft failure is a service that returned `success: false` WITHOUT throwing.
 * It is recorded as 'failed' (not 'done') so a later recovery pass retries it —
 * provisioning services are idempotent, so a retry converges rather than
 * duplicating. A thrown error is likewise 'failed'.
 */
export async function runDurableProvisioning(
  args: { projectId: string; phases: PhasePlan[] },
  ledger: StepLedger,
): Promise<DurableProvisioningResult> {
  const existing = await ledger.getSteps(args.projectId)
  const done = new Map<string, Record<string, unknown>>()
  for (const s of existing) if (s.status === 'done') done.set(s.service, s.result || {})

  const results: Record<string, StepResult> = {}
  const resumed: string[] = []
  const ran: string[] = []
  for (const [service, result] of done) {
    results[service] = result as StepResult
    resumed.push(service)
  }

  for (const phase of args.phases) {
    const steps = phase(results)
    const pending = steps.filter((s) => !done.has(s.service))

    // Ownership gate: verify the lease is still ours IMMEDIATELY BEFORE this
    // phase's external writes. If a newer holder reclaimed it, stop before
    // dispatching any create — a stale worker never double-provisions.
    if (pending.length > 0 && ledger.renew && !(await ledger.renew())) {
      return { results, resumed, ran, abortedLostLease: true }
    }

    const settled = await Promise.all(
      pending.map(async (s) => {
        await ledger.markStep(args.projectId, s.service, { status: 'running' })
        try {
          const r = (await s.run()) || {}
          const success = r.success !== false
          await ledger.markStep(args.projectId, s.service, {
            status: success ? 'done' : 'failed',
            result: r as Record<string, unknown>,
            error: success ? null : String(r.error ?? 'failed'),
          })
          return { service: s.service, result: r }
        } catch (err) {
          const r: StepResult = { service: s.service, success: false, error: (err as Error).message }
          await ledger.markStep(args.projectId, s.service, {
            status: 'failed',
            result: r as Record<string, unknown>,
            error: (err as Error).message,
          })
          return { service: s.service, result: r }
        }
      }),
    )
    for (const { service, result } of settled) {
      results[service] = result
      ran.push(service)
    }
  }

  return { results, resumed, ran, abortedLostLease: false }
}
