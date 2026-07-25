/**
 * Slack HTTP authorization denial — response + logging.
 *
 * Deliberately Slack-scoped: this is NOT a generic webhook-auth layer. Slack's
 * request-signing protocol is owned by ./verify.ts, and these two helpers exist
 * only so both Slack HTTP routes deny identically. Any other provider gets its
 * own owner rather than a shared abstraction.
 *
 * Contract:
 *   - the external response is byte-identical for every denial reason, so a
 *     caller cannot distinguish "server misconfigured" from "bad signature";
 *   - the reason is recorded in logs only, as a stable machine-readable code;
 *   - nothing derived from the signature, the signing secret, an authorization
 *     header, or the raw body is logged — only presence booleans and the
 *     platform request id.
 */

import { NextResponse } from 'next/server'

/** Stable reason codes. Log-only — never returned to the caller. */
export type SlackAuthDenialReason = 'signing_secret_missing' | 'invalid_signature'

/** The single external denial body. Uniform across reasons by design. */
export const SLACK_AUTH_DENIED_BODY = { error: 'unauthorized' } as const

export function slackAuthDenied(opts: {
  route: string
  reason: SlackAuthDenialReason
  request: Request
}): NextResponse {
  const { route, reason, request } = opts

  console.warn(
    JSON.stringify({
      evt: 'slack_auth_denied',
      route,
      reason,
      request_id: request.headers.get('x-vercel-id') || null,
      // Presence only. The values themselves are credential material.
      signature_present: Boolean(request.headers.get('x-slack-signature')),
      timestamp_present: Boolean(request.headers.get('x-slack-request-timestamp')),
    }),
  )

  return NextResponse.json(SLACK_AUTH_DENIED_BODY, { status: 401 })
}
