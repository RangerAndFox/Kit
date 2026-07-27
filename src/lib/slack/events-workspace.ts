/**
 * Slack Events → Kit workspace binding, and the scheduling boundary it guards.
 *
 * A verified Slack signature proves Slack sent the request. It does NOT
 * authorize the sending Slack team to act inside a Kit workspace. Workspace
 * identity therefore comes from exactly one place: an exact
 * `workspaces.slack_team_id` binding for the signed payload's `team_id`.
 * There is deliberately no fallback — no "first workspace", no default, and no
 * value read from a body field, query parameter, header, or configuration.
 *
 * Anything short of exactly one binding is unauthorized for side-effect
 * purposes: a missing `team_id`, no match, a lookup error, or an ambiguous
 * result. The caller must then return the fixed acknowledgement below WITHOUT
 * scheduling work.
 *
 * Slack-owned by design: this is not a generic authorization layer and not a
 * cross-provider abstraction. Both ports are injectable so the guarantees are
 * unit-testable without Supabase or a Next request context; production wiring
 * stays the Supabase admin client and Next's `after()`.
 */

import { NextResponse, after } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

/** Log-only reason codes. The external acknowledgement is identical for all. */
export type SlackWorkspaceDenialReason =
  | 'team_id_missing'
  | 'workspace_binding_not_found'
  | 'workspace_binding_lookup_failed'

export type WorkspaceResolution =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: SlackWorkspaceDenialReason }

/** Binding lookup port. Throws on any database failure; never returns a default. */
export type WorkspaceBindingLookup = (teamId: string) => Promise<{ ids: string[] }>

/** Work that may only be scheduled once a workspace binding is established. */
export interface SlackScheduledWork {
  workspaceId: string
  run: () => Promise<void>
}
export type SlackWorkScheduler = (work: SlackScheduledWork) => void

/**
 * Production lookup. `limit(2)` on purpose: it makes "exactly one binding"
 * decidable, so an ambiguous mapping is rejected instead of silently taking a row.
 */
const productionLookup: WorkspaceBindingLookup = async (teamId) => {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('workspaces')
    .select('id')
    .eq('slack_team_id', teamId)
    .limit(2)

  // Never downgrade an error to "no binding" — the caller must not be able to
  // distinguish them, but internally a failure stays a failure.
  if (error) throw new Error('workspace binding lookup failed')
  return { ids: (data ?? []).map((row) => row.id) }
}

const productionScheduler: SlackWorkScheduler = (work) => {
  after(work.run)
}

let lookup: WorkspaceBindingLookup = productionLookup
let scheduler: SlackWorkScheduler = productionScheduler

/** Test seam. Pass null to restore the production ports. */
export function __setSlackEventPortsForTests(
  ports: { lookup?: WorkspaceBindingLookup; scheduler?: SlackWorkScheduler } | null,
): void {
  lookup = ports?.lookup ?? productionLookup
  scheduler = ports?.scheduler ?? productionScheduler
}

/**
 * Resolve a signed Slack `team_id` to exactly one bound Kit workspace.
 * Every failure mode is unauthorized; none of them yields a workspace id.
 */
export async function resolveBoundWorkspace(teamId: unknown): Promise<WorkspaceResolution> {
  if (typeof teamId !== 'string' || teamId.trim() === '') {
    return { ok: false, reason: 'team_id_missing' }
  }

  let ids: string[]
  try {
    ids = (await lookup(teamId)).ids
  } catch {
    return { ok: false, reason: 'workspace_binding_lookup_failed' }
  }

  if (ids.length === 0) return { ok: false, reason: 'workspace_binding_not_found' }
  // More than one binding for one Slack team is an invalid mapping, not a choice.
  if (ids.length > 1) return { ok: false, reason: 'workspace_binding_lookup_failed' }

  const workspaceId = ids[0]
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    return { ok: false, reason: 'workspace_binding_lookup_failed' }
  }
  return { ok: true, workspaceId }
}

/** Schedule post-acknowledgement work. Only reachable with a resolved workspace. */
export function scheduleSlackWork(work: SlackScheduledWork): void {
  scheduler(work)
}

/**
 * The single external acknowledgement for an unbound Slack team. It is a 2xx so
 * Slack does not retry-storm a condition retries cannot fix, and it is identical
 * for every internal reason so no binding, configuration, or database detail leaks.
 */
export const SLACK_WORKSPACE_UNBOUND_BODY = { ok: true, ignored: 'workspace_unbound' } as const

export function slackWorkspaceUnbound(opts: {
  route: string
  reason: SlackWorkspaceDenialReason
  request: Request
}): NextResponse {
  const { route, reason, request } = opts

  console.warn(
    JSON.stringify({
      evt: 'slack_workspace_unbound',
      route,
      reason,
      request_id: request.headers.get('x-vercel-id') || null,
      team_id_present: reason !== 'team_id_missing',
    }),
  )

  return NextResponse.json(SLACK_WORKSPACE_UNBOUND_BODY, { status: 200 })
}
