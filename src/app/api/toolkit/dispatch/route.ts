/**
 * POST /api/toolkit/dispatch — DISABLED.
 *
 * This endpoint previously dispatched a Managed Agent session (an `agent_runs`
 * write plus an external agent call) for any caller, with `workspaceId` and
 * `projectId` taken from the request body and the project lookup unscoped by
 * workspace. It had no caller verification.
 *
 * It also had no caller at all: the Toolkit tab that appears to drive it
 * (src/app/(app)/projects/[id]/toolkit-tab.tsx) simulates its work with a
 * timer and never calls this route, and no external caller exists in the
 * repository, the organization's code, or the deployment's invocation history.
 *
 * Because the product surface may return, the path is kept as an explicit,
 * inert 404 rather than deleted. The disable is STRUCTURAL, not configuration-
 * gated: this module imports nothing that can reach Supabase, the agent
 * registry, the session manager, or any external provider, and it never reads
 * the request body — so no body, query, or header value can select a workspace.
 *
 * Re-enabling is a deliberate change that must, in the same commit, establish a
 * verified caller (for a dashboard surface: the Supabase session already
 * refreshed by src/proxy.ts) and derive the workspace from that verified
 * identity — never from caller input.
 */

import { NextResponse } from 'next/server'

const ROUTE = '/api/toolkit/dispatch'

/** The single fixed disabled response. No reason or configuration state leaks. */
const DISABLED_BODY = { error: 'not_found' } as const

function disabled(request: Request): NextResponse {
  console.warn(
    JSON.stringify({
      evt: 'route_disabled',
      route: ROUTE,
      reason: 'toolkit_dispatch_disabled',
      request_id: request.headers.get('x-vercel-id') || null,
    }),
  )
  return NextResponse.json(DISABLED_BODY, { status: 404 })
}

export async function POST(request: Request) {
  return disabled(request)
}
