import { NextResponse } from 'next/server'
import { getControlCenterAccess } from '@/lib/control-center/access'
import { loadControlCenterData } from '@/lib/control-center/data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const access = await getControlCenterAccess()
  if (!access) {
    return NextResponse.json({ error: 'Founder access required.' }, { status: 403 })
  }

  try {
    const payload = await loadControlCenterData({
      workspaceId: access.workspaceId,
      workspaceName: access.workspaceName,
      displayName: access.displayName,
      role: access.role,
    })
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    })
  } catch (error: unknown) {
    console.error('[control-center] API load failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Control Center data could not be loaded.' },
      { status: 500 },
    )
  }
}
