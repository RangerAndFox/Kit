/**
 * POST /api/toolkit/script — DISABLED.
 *
 * The former handler trusted caller-supplied project/workspace ids, searched
 * private knowledge through the Supabase service role, called Anthropic, and
 * wrote generated_documents without authenticating the caller.
 */

import { NextResponse } from 'next/server'

export async function POST() {
  console.warn(JSON.stringify({
    evt: 'route_disabled',
    route: '/api/toolkit/script',
    reason: 'toolkit_script_disabled',
  }))
  return NextResponse.json({ error: 'not_found' }, { status: 404 })
}
