/**
 * GET /api/auth/callback — DISABLED Frame.io/Adobe bootstrap callback.
 *
 * Adobe authentication is not Kit authorization. The former callback had no
 * operator session or OAuth state binding and replaced the singleton production
 * refresh token for any valid Adobe authorization code. It also reflected raw
 * query/provider text into HTML and returned the refresh token on a DB failure.
 *
 * Frame.io continues to use the existing database/env refresh token. Re-enable
 * browser bootstrap only with a single-use state bound to an authorized Kit
 * operator and a fixed allowlisted redirect URI; never return token material.
 */

import { NextResponse } from 'next/server'

export async function GET() {
  console.warn(JSON.stringify({
    evt: 'route_disabled',
    route: '/api/auth/callback',
    reason: 'frameio_oauth_callback_disabled',
  }))
  return NextResponse.json({ error: 'not_found' }, { status: 404 })
}
