// @ts-nocheck
/**
 * GET /api/status — live health JSON for the /status page (and any external
 * uptime monitor). Runs the same probes the watchdog uses. Returns 200 when
 * everything's green, 503 when anything is down, so a plain HTTP monitor can
 * alert on it too.
 */

import { NextResponse } from 'next/server'
import { runAllChecks } from '@/lib/health/run'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const checks = await runAllChecks()
    const ok = checks.every((c) => c.ok)
    return NextResponse.json(
      { ok, checkedAt: new Date().toISOString(), checks },
      { status: ok ? 200 : 503 },
    )
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, checkedAt: new Date().toISOString(), error: String(err?.message || err), checks: [] },
      { status: 500 },
    )
  }
}
