/**
 * Durable per-service provisioning fan-out (Railway-owned), with deterministic
 * per-step ownership.
 *
 * Each service step is CLAIMED atomically (holder + monotonic fence) before it
 * runs; the final result write is conditional on that exact holder/fence, so a
 * stale worker whose lease was reclaimed cannot commit over a newer one. A
 * resume runs only steps that are not `done`/`terminal`, reusing stored results.
 *
 * Completion is DB-backed and computed from the persisted ledger AFTER the pass:
 *   - allRequiredDone  → every required step reached `done`;
 *   - anyTerminal      → a required step is a PERMANENT (visible) failure;
 *   - otherwise there are retryable (failed/running/pending) steps left.
 *
 * getSteps THROWS on a store error (it must never look like an empty ledger and
 * replay every service). Pure + injected (StepLedger) so it is unit-tested.
 */

export interface StepResult {
  service?: string
  success?: boolean
  error?: string
  /** A service sets terminal:true for a PERMANENT failure (never auto-retried). */
  terminal?: boolean
  /** External identity, persisted the instant it is known. */
  id?: string
  url?: string
  [k: string]: unknown
}

export interface PersistedStep {
  service: string
  status: string
  result: Record<string, unknown> | null
}

export interface StepLedger {
  /** Throws on store error — never returns an empty ledger to mask a failure. */
  getSteps(projectId: string): Promise<PersistedStep[]>
  /** Atomic claim; ok=false with status 'done'|'terminal' (reuse/skip) or in-flight. */
  claimStep(
    projectId: string,
    service: string,
    inputHash?: string,
  ): Promise<{ ok: boolean; fence: number | null; status: string }>
  /** Persist external identity the instant it is known (holder/fence-conditional). */
  recordExternalId?(
    projectId: string,
    service: string,
    fence: number,
    o: { externalId?: string | null; externalUrl?: string | null },
  ): Promise<boolean>
  /** Final result write — conditional on the exact holder/fence. */
  completeStep(
    projectId: string,
    service: string,
    fence: number,
    patch: {
      status: 'done' | 'failed' | 'terminal'
      result?: Record<string, unknown> | null
      error?: string | null
      externalId?: string | null
      externalUrl?: string | null
    },
  ): Promise<boolean>
  /**
   * Ownership check + heartbeat on the REQUEST lease, verified before each
   * phase's writes. Returns false when a newer holder reclaimed it → stop.
   */
  renew?: () => Promise<boolean>
}

/** A phase: given results so far, the services to run (in parallel) this phase. */
export type PhasePlan = (
  accumulated: Record<string, StepResult>,
) => Array<{ service: string; run: () => Promise<StepResult>; inputHash?: string }>

export interface DurableProvisioningResult {
  results: Record<string, StepResult>
  resumed: string[]
  ran: string[]
  /** Steps skipped because another worker holds an active claim. */
  skippedInFlight: string[]
  /** Steps whose commit was rejected because ownership was lost. */
  lostOwnership: string[]
  abortedLostLease: boolean
  /** Per-service persisted status after the pass (authoritative, DB-backed). */
  statusByService: Record<string, string>
  /** True only when every required service reached `done`. */
  allRequiredDone: boolean
  /** True when a required service is a permanent (terminal) failure. */
  anyTerminal: boolean
  /** Required services not yet `done` (retryable or terminal). */
  incompleteServices: string[]
}

export async function runDurableProvisioning(
  args: { projectId: string; phases: PhasePlan[]; requiredServices?: string[] },
  ledger: StepLedger,
): Promise<DurableProvisioningResult> {
  const existing = await ledger.getSteps(args.projectId) // throws on store error
  const done = new Map<string, Record<string, unknown>>()
  for (const s of existing) if (s.status === 'done') done.set(s.service, s.result || {})

  const results: Record<string, StepResult> = {}
  const resumed: string[] = []
  const ran: string[] = []
  const skippedInFlight: string[] = []
  const lostOwnership: string[] = []
  for (const [service, result] of done) {
    results[service] = result as StepResult
    resumed.push(service)
  }

  let abortedLostLease = false
  for (const phase of args.phases) {
    const steps = phase(results).filter((s) => !done.has(s.service))
    if (steps.length === 0) continue

    // Request-lease gate before the phase's writes (defence in depth on top of
    // per-step ownership).
    if (ledger.renew && !(await ledger.renew())) {
      abortedLostLease = true
      break
    }

    const settled = await Promise.all(
      steps.map(async (s) => {
        const claim = await ledger.claimStep(args.projectId, s.service, s.inputHash)
        if (!claim.ok) {
          if (claim.status === 'done') {
            // Another worker finished it — reuse from the ledger read below.
            return { service: s.service, kind: 'already_done' as const }
          }
          if (claim.status === 'terminal') return { service: s.service, kind: 'terminal' as const }
          skippedInFlight.push(s.service)
          return { service: s.service, kind: 'in_flight' as const }
        }
        const fence = claim.fence as number
        try {
          const r = (await s.run()) || {}
          // Persist external identity BEFORE the final write, so a crash between
          // them still reconciles to it (holder/fence-conditional).
          if (ledger.recordExternalId && (r.id != null || r.url != null)) {
            await ledger.recordExternalId(args.projectId, s.service, fence, {
              externalId: r.id != null ? String(r.id) : undefined,
              externalUrl: r.url != null ? String(r.url) : undefined,
            })
          }
          const success = r.success !== false
          const status = success ? 'done' : r.terminal === true ? 'terminal' : 'failed'
          const committed = await ledger.completeStep(args.projectId, s.service, fence, {
            status,
            result: r as Record<string, unknown>,
            error: success ? null : String(r.error ?? 'failed'),
            externalId: r.id != null ? String(r.id) : undefined,
            externalUrl: r.url != null ? String(r.url) : undefined,
          })
          if (!committed) return { service: s.service, kind: 'lost' as const, result: r }
          return { service: s.service, kind: 'ran' as const, result: r }
        } catch (err) {
          const r: StepResult = { service: s.service, success: false, error: (err as Error).message }
          await ledger.completeStep(args.projectId, s.service, fence, {
            status: 'failed',
            result: r as Record<string, unknown>,
            error: (err as Error).message,
          })
          return { service: s.service, kind: 'ran' as const, result: r }
        }
      }),
    )
    for (const o of settled) {
      if (o.kind === 'ran') {
        results[o.service] = o.result
        ran.push(o.service)
      } else if (o.kind === 'lost') {
        lostOwnership.push(o.service)
      }
    }
  }

  // Completion is computed from the PERSISTED ledger (authoritative), re-read so
  // a concurrent finisher's result counts and an uncommitted local one doesn't.
  const finalSteps = await ledger.getSteps(args.projectId) // throws on store error
  const statusByService: Record<string, string> = {}
  for (const s of finalSteps) statusByService[s.service] = s.status
  const required = args.requiredServices ?? []
  const incompleteServices = required.filter((svc) => statusByService[svc] !== 'done')
  const allRequiredDone = required.length > 0 && incompleteServices.length === 0
  const anyTerminal = required.some((svc) => statusByService[svc] === 'terminal')

  return {
    results,
    resumed,
    ran,
    skippedInFlight,
    lostOwnership,
    abortedLostLease,
    statusByService,
    allRequiredDone,
    anyTerminal,
    incompleteServices,
  }
}
