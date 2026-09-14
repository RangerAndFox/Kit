import { randomUUID } from 'node:crypto'
import { OFFBOARD_STEPS, finished, type OffboardRequest, type OffboardStep, type StepResult } from './types'
import { claimOffboarding, checkpoint } from './store'

export interface OffboardingPorts {
  claim(request: OffboardRequest, owner: string): Promise<OffboardRequest>
  checkpoint(request: OffboardRequest, owner: string, step?: OffboardStep, result?: StepResult, finish?: boolean): Promise<void>
  run(step: OffboardStep, request: OffboardRequest, beforeWrite: () => Promise<void>): Promise<StepResult>
}
export const defaultOffboardingStore = { claim: claimOffboarding, checkpoint }

/** Only revocations may retry. A lost checkpoint stops this worker; the durable
 * offboarding hold prevents onboarding from undoing a partly completed removal. */
export async function runOffboarding(input: OffboardRequest, ports: OffboardingPorts): Promise<OffboardRequest> {
  if (input.status === 'complete') return input
  const owner = randomUUID()
  const request = await ports.claim(input, owner)
  for (const step of OFFBOARD_STEPS) {
    if (finished(request.results[step])) continue
    await ports.checkpoint(request, owner)
    let result: StepResult
    try {
      result = await ports.run(step, request, () => ports.checkpoint(request, owner))
    } catch {
      // No raw provider response, private input or credentials in logs/UI.
      result = { status: 'failed', detail: 'Provider verification failed. Access may still exist; retry or review in the provider.' }
    }
    // Intentionally outside catch: never continue if durable acknowledgement failed.
    await ports.checkpoint(request, owner, step, result)
    request.results[step] = result
  }
  await ports.checkpoint(request, owner, undefined, undefined, true)
  request.status = OFFBOARD_STEPS.every(step => finished(request.results[step])) ? 'complete' : 'partial'
  return request
}
