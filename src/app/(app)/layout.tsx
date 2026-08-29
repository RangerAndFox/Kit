import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AppNavigation } from './app-navigation'
import { getControlCenterAccess } from '@/lib/control-center/access'

export const metadata = {
  title: 'Kit — Dashboard',
  description: 'Production intelligence dashboard',
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  // Check if user is authenticated
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()

  if (userError || !user) {
    redirect('/login')
  }

  // Check if user has completed onboarding
  const { data: workspaces } = await supabase
    .from('workspaces')
    .select('id')
    .limit(1)

  if (!workspaces || workspaces.length === 0) {
    const founderAccess = await getControlCenterAccess()
    if (!founderAccess) redirect('/onboarding')
  }

  return (
    <div className="flex min-h-screen bg-[#0C0E12]">
      <AppNavigation />
      <main className="min-w-0 flex-1 overflow-hidden pb-16 md:pb-0">
        {children}
      </main>
    </div>
  )
}
