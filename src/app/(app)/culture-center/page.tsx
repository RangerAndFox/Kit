import { redirect } from 'next/navigation'
import { getControlCenterAccess } from '@/lib/control-center/access'
import { loadCultureData } from '@/lib/culture/store'
import { CultureCenter } from './culture-center'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Culture Center — Kit', description: 'Memes, celebrations and the rituals that make the studio.' }
export default async function CultureCenterPage() {
  const access = await getControlCenterAccess()
  if (!access) redirect('/access-denied')
  const data = await loadCultureData(access.workspaceId)
  return <CultureCenter initialData={data} />
}
