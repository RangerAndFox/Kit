/**
 * The update-project ripple executor (Railway-owned, shared lib).
 *
 * Given a computed UpdatePlan, it renames the flagged outlets and updates Kit's
 * records, DURABLY and IDEMPOTENTLY by delegating to the same
 * `runDurableProvisioning` engine the create path uses — backed by the
 * per-(update_request, service) step ledger (migration 063), so a Railway
 * restart mid-ripple resumes only the services that have not yet applied.
 *
 * Phases (barriered in order):
 *   A. external renames (slack / frameio / harvest / dropbox), in parallel;
 *   B. the Master Project List row (the Canvas re-renders from it via sync);
 *   C. the Supabase projects row (last, so it never races Phase A's eager write
 *      of the moved Dropbox folder's safe-name).
 *
 * All external calls go through injected `deps` so this is unit-tested without
 * the network or a DB. It does NOT set projects.status or the request status —
 * the caller finalizes from the returned outcome (keeping the executor a pure
 * orchestrator over deps + ledger).
 */

import { deriveProjectIdentifiers } from './identifiers'
import type { UpdateForm, UpdatePlan } from './update-diff'
import { runDurableProvisioning, type StepLedger, type PhasePlan } from '../project-control/provisioning-steps'

/**
 * A single step's result — the loose agent-result shape the ledger memoizes.
 * A `type` alias (not an interface) so it carries an implicit index signature and
 * stays assignable to the engine's `StepResult` (`[k: string]: unknown`).
 */
export type UpdateStepRunResult = {
  success: boolean
  terminal?: boolean
  id?: string
  url?: string
  message?: string
  error?: string
  data?: Record<string, unknown>
}

/** The current external identifiers a rename needs (reconcile-by-marker aside). */
export interface UpdateCurrentIds {
  /** The project channel id (Slack rename target; id never changes). */
  slackChannelId?: string | null
  /** The current Dropbox folder path `/production/{year}/{safeName}` (move source). */
  dropboxPath?: string | null
}

export interface RunProjectUpdateArgs {
  /** The update-request id — the OPAQUE ledger key for the step fan-out. */
  requestKey: string
  projectId: string
  submission: UpdateForm
  plan: UpdatePlan
  current: UpdateCurrentIds
}

export interface UpdateDeps {
  /** Dispatch a rename to a service agent. */
  dispatch: (service: string, action: string, payload: Record<string, unknown>) => Promise<UpdateStepRunResult>
  /**
   * Persist a completed Dropbox move to the projects row: external_ids
   * .dropbox_safe_name AND external_links.dropbox = new path. MUST run before the
   * dropbox step completes — delivery matching keys off dropbox_safe_name, so it
   * has to stay in lockstep with the folder.
   */
  persistDropboxMove: (projectId: string, o: { safeName: string; path: string; url?: string }) => Promise<void>
  /** Update the Master Project List bound row (acquires/releases its own lease). */
  updateSheet: (projectId: string, form: UpdateForm) => Promise<UpdateStepRunResult>
  /** Update the Supabase projects row (reads fresh; merges external_ids). */
  updateProjectRow: (
    projectId: string,
    form: UpdateForm,
    derived: { projectCode: string },
  ) => Promise<UpdateStepRunResult>
  /** The durable step ledger (update-store adapters, keyed by requestKey). */
  ledger: StepLedger
}

export interface UpdateOutcome {
  ran: string[]
  resumed: string[]
  incompleteServices: string[]
  allRequiredDone: boolean
  anyTerminal: boolean
  abortedLostLease: boolean
  results: Record<string, UpdateStepRunResult>
  /** Suggested projects.status for the caller to persist. */
  finalStatus: 'active' | 'partial'
}

export async function runProjectUpdate(
  args: RunProjectUpdateArgs,
  deps: UpdateDeps,
): Promise<UpdateOutcome> {
  const { requestKey, projectId, submission: form, plan, current } = args

  // Recompute the identity strings from the NEW values (shared derivation, so
  // the rename targets match what create produced for these inputs).
  const ids = deriveProjectIdentifiers({
    projectId,
    projectNumber: form.projectNumber,
    client: form.clientName,
    projectName: form.projectName,
  })

  const basePayload: Record<string, unknown> = {
    projectId,
    projectName: form.projectName,
    client: form.clientName,
    clientName: form.clientName,
    projectNumber: form.projectNumber,
    projectCode: ids.projectCode,
  }

  const externalServices = (['slack', 'frameio', 'harvest', 'dropbox'] as const).filter(
    (s) => plan.services[s],
  )

  const runExternalRename = async (service: string): Promise<UpdateStepRunResult> => {
    if (service === 'slack') {
      return deps.dispatch('slack', 'rename', { ...basePayload, channelId: current.slackChannelId ?? undefined })
    }
    if (service === 'dropbox') {
      const r = await deps.dispatch('dropbox', 'rename', { ...basePayload, fromPath: current.dropboxPath ?? undefined })
      // On success, keep the projects row's dropbox identity in lockstep with the
      // folder BEFORE the step completes. If this throws, the step is retryable
      // and the (idempotent) move + write re-run — never a half-applied move.
      if (r.success && r.data && typeof r.data.newSafeName === 'string') {
        await deps.persistDropboxMove(projectId, {
          safeName: r.data.newSafeName as string,
          path: (r.data.path as string) || r.id || '',
          url: r.url,
        })
      }
      return r
    }
    // harvest / frameio reconcile by the embedded Kit marker — base fields suffice.
    return deps.dispatch(service, 'rename', basePayload)
  }

  const required: string[] = [...externalServices]
  if (plan.services.sheet) required.push('sheet')
  if (plan.services.supabase) required.push('supabase')

  const phases: PhasePlan[] = []
  if (externalServices.length > 0) {
    phases.push(() => externalServices.map((service) => ({ service, run: () => runExternalRename(service) })))
  }
  if (plan.services.sheet) {
    phases.push(() => [{ service: 'sheet', run: () => deps.updateSheet(projectId, form) }])
  }
  if (plan.services.supabase) {
    phases.push(() => [
      { service: 'supabase', run: () => deps.updateProjectRow(projectId, form, { projectCode: ids.projectCode }) },
    ])
  }

  const outcome = await runDurableProvisioning(
    { projectId: requestKey, phases, requiredServices: required },
    deps.ledger,
  )

  return {
    ran: outcome.ran,
    resumed: outcome.resumed,
    incompleteServices: outcome.incompleteServices,
    allRequiredDone: outcome.allRequiredDone,
    anyTerminal: outcome.anyTerminal,
    abortedLostLease: outcome.abortedLostLease,
    results: outcome.results as Record<string, UpdateStepRunResult>,
    finalStatus: outcome.allRequiredDone ? 'active' : 'partial',
  }
}
