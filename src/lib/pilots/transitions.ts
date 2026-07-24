/**
 * Pilots — pure state-transition guards and authorization.
 *
 * No I/O. These encode the mission's integrity rules so they are unit-testable
 * independently of Slack/Supabase:
 *   - authorization never trusts button visibility (workspace-scoped);
 *   - a pilot can only finalize when the deterministic completeness gate passes
 *     AND a valid human recommendation is supplied;
 *   - the recommendation is validated against the enum here — it is entered by a
 *     human and rendered by Kit, never generated or selected by a model.
 */

import { PILOT_RECOMMENDATIONS, type PilotRecommendation, type PilotRow } from './types'
import { evaluateCompleteness, type CompletenessResult } from './completeness'
import type { PilotSnapshot } from './types'

// ─── Authorization ───────────────────────────────────────────────────────────

export interface PilotActionContext {
  actingUserId: string
  workspaceId: string
}

export type AuthDecision =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'wrong_workspace' | 'not_authorized' | 'invalid_state' }

/**
 * Authorize a mutating pilot action. Mirrors project-control's
 * `authorizeResolution`: the request must belong to the acting workspace and the
 * acting user must be identified. Button visibility / id secrecy is never the
 * gate. (Role checks beyond workspace membership are deferred to the caller's
 * existing access-control resolution.)
 */
export function authorizePilotAction(pilot: PilotRow | null, ctx: PilotActionContext): AuthDecision {
  if (!pilot) return { ok: false, reason: 'not_found' }
  if (!pilot.workspace_id || pilot.workspace_id !== ctx.workspaceId) return { ok: false, reason: 'wrong_workspace' }
  if (!ctx.actingUserId) return { ok: false, reason: 'not_authorized' }
  return { ok: true }
}

// ─── Recommendation validation ───────────────────────────────────────────────

export function isValidRecommendation(value: string): value is PilotRecommendation {
  return (PILOT_RECOMMENDATIONS as readonly string[]).includes(value)
}

// Type-guard narrowing (not boolean-discriminant narrowing) so consumers compile
// under both the root strict tsconfig and Bolt's non-strict one.
export function isAuthDenied(a: AuthDecision): a is Extract<AuthDecision, { ok: false }> {
  return !a.ok
}
export function isFinalizeBlocked(d: FinalizeDecision): d is Extract<FinalizeDecision, { ok: false }> {
  return !d.ok
}

// ─── Finalization guard ──────────────────────────────────────────────────────

export type FinalizeDecision =
  | { ok: true; recommendation: PilotRecommendation }
  | { ok: false; reason: 'already_terminal' | 'invalid_recommendation' | 'incomplete_evidence'; completeness?: CompletenessResult }

/**
 * Decide whether a pilot may transition to 'finalized' with the given
 * human-supplied recommendation. Refuses when:
 *   - the pilot is already terminal (finalized/abandoned);
 *   - the recommendation is not one of the four allowed values;
 *   - the deterministic evidence-completeness gate does not pass.
 *
 * This is the single guard the state-transition owner consults; the completeness
 * check is deterministic and structural, not advisory.
 */
export function decideFinalize(snapshot: PilotSnapshot, recommendation: string): FinalizeDecision {
  if (snapshot.pilot.status !== 'active') {
    return { ok: false, reason: 'already_terminal' }
  }
  if (!isValidRecommendation(recommendation)) {
    return { ok: false, reason: 'invalid_recommendation' }
  }
  const completeness = evaluateCompleteness(snapshot)
  if (!completeness.complete) {
    return { ok: false, reason: 'incomplete_evidence', completeness }
  }
  return { ok: true, recommendation }
}
