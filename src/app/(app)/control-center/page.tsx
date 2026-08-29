import { redirect } from 'next/navigation'
import { ControlCenter } from './control-center'
import { getControlCenterAccess } from '@/lib/control-center/access'
import { loadControlCenterData } from '@/lib/control-center/data'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Control Center — Kit',
  description: 'Live operational health, usage, queues, workers and project status for Kit.',
}

export default async function ControlCenterPage() {
  const access = await getControlCenterAccess()
  if (!access) redirect('/projects')

  const initialData = await loadControlCenterData({
    workspaceId: access.workspaceId,
    workspaceName: access.workspaceName,
    displayName: access.displayName,
    role: access.role,
  })

  return <ControlCenter initialData={initialData} />
}
