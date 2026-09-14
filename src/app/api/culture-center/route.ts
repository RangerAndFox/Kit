import { getControlCenterAccess } from '@/lib/control-center/access'
import { handleCulture } from '@/lib/culture/http'
import { initializeCulture, loadCultureData, saveMeme } from '@/lib/culture/store'

export const runtime = 'nodejs'
const ports = { access: getControlCenterAccess, load: loadCultureData, initialize: initializeCulture, save: saveMeme }
export const GET = (request: Request) => handleCulture(request, ports)
export const POST = (request: Request) => handleCulture(request, ports)
