import { getControlCenterAccess } from '@/lib/control-center/access'
import { loadWorkingWorld } from '@/lib/working-world/data'
import { handleWorld } from '@/lib/working-world/http'

export const dynamic = 'force-dynamic'
export const maxDuration = 20
export async function GET(request: Request) {
  return handleWorld(request, { access: getControlCenterAccess, load: loadWorkingWorld })
}
export async function POST(request: Request) {
  return handleWorld(request, { access: getControlCenterAccess, load: loadWorkingWorld })
}
