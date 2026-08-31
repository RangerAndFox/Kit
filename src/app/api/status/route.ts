/**
 * Public liveness only. Privileged provider probes belong in authenticated
 * Control Center data and internal health jobs, never in an anonymous route.
 */

import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(
    { ok: true, checkedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
