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

  // The current web dashboard intentionally serves founders/admins only.
  // Do not render privileged navigation and then fail later in individual
  // pages for otherwise valid staff sessions.
  const appAccess = await getControlCenterAccess()
  if (!appAccess) redirect('/access-denied')

  // `getControlCenterAccess()` already resolves the caller's authoritative
  // workspace through the founder/admin membership record. Do not repeat that
  // check through the user-scoped `workspaces` relation: legacy founder rows
  // may be linked by verified email rather than `auth_user_id`, so the RLS
  // query can return zero rows even though `appAccess.workspaceId` is valid.

  return (
    <div className="flex min-h-screen bg-[#08090a]">
      <AppNavigation />
      <main className="min-w-0 flex-1 overflow-hidden pb-16 md:pb-0">
        {children}
      </main>
    </div>
  )
}
