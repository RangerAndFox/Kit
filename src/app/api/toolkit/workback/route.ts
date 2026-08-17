/**
 * POST /api/toolkit/workback — DISABLED.
 *
 * The former handler trusted caller-supplied project/workspace ids, read through
 * the Supabase service role, made a large paid model call, and wrote a schedule
 * without authenticating the caller. Re-enable only with session-derived scope
 * and explicit role/cost authorization.
 */

import { NextResponse } from 'next/server'

export async function POST() {
  console.warn(JSON.stringify({
    evt: 'route_disabled',
    route: '/api/toolkit/workback',
    reason: 'toolkit_workback_disabled',
  }))
  return NextResponse.json({ error: 'not_found' }, { status: 404 })
}
