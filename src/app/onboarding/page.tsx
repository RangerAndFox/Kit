import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { OnboardingWizard } from './wizard'

export const metadata = {
  title: 'Onboarding — Kit',
  description: 'Set up your Kit studio workspace',
}

export default async function OnboardingPage() {
  const supabase = await createClient()

  // Check if user is authenticated
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()

  if (userError || !user) {
    // Redirect to auth/login page (you'll need to implement this)
    redirect('/login')
  }

  // Check if user already has a workspace
  const { data: userWorkspaces } = await supabase
    .from('workspaces')
    .select('id')
    .limit(1)

  if (userWorkspaces && userWorkspaces.length > 0) {
    // User already has a workspace, redirect to dashboard
    redirect('/control-center')
  }

  return <OnboardingWizard />
}
