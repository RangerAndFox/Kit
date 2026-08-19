/**
 * POST /api/toolkit/sow — DISABLED.
 *
 * The former handler trusted caller-supplied project/workspace ids, read through
 * the Supabase service role, called Anthropic, and wrote generated_documents
 * without authenticating the caller. Keep the path as an inert 404 until a real
 * dashboard caller derives workspace authority from its verified session.
 */

import { NextResponse } from 'next/server'

export async function POST() {
  console.warn(JSON.stringify({
    evt: 'route_disabled',
    route: '/api/toolkit/sow',
    reason: 'toolkit_sow_disabled',
  }))
  return NextResponse.json({ error: 'not_found' }, { status: 404 })
}
