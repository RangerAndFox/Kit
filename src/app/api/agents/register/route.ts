import { NextResponse } from 'next/server'

/** Dormant managed-agent subsystem: no verified dispatch consumer exists.
 * Registration must not create external resources for an unwired runtime.
 * Do not restore without a signed-identity caller and an end-to-end workflow.
 */
export async function POST() {
  return NextResponse.json({ error: 'Managed-agent registration is unavailable' }, { status: 404 })
}
