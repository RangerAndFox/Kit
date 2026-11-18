import { redirect } from 'next/navigation'
import { getControlCenterAccess } from '@/lib/control-center/access'
import { loadWorkingWorld } from '@/lib/working-world/data'
import { WorkingWorld } from './working-world'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Working World — Ranger & Fox', description: 'A read-only, live view of studio agents, workflows and operational evidence.' }
export default async function WorkingWorldPage() {
  const access = await getControlCenterAccess()
  if (!access) redirect('/projects')
  const initialData = await loadWorkingWorld({ workspaceId: access.workspaceId, workspaceName: access.workspaceName })
  return <WorkingWorld initialData={initialData} />
}
