import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getControlCenterAccess } from '@/lib/control-center/access'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      const { data: { user } } = await supabase.auth.getUser()

      if (user) {
        const founderAccess = await getControlCenterAccess()
        if (founderAccess) {
          return NextResponse.redirect(`${origin}/control-center`)
        }

        const { data: member } = await supabase
          .from('team_members')
          .select('workspace_id')
          .eq('auth_user_id', user.id)
          .single() as unknown as { data: { workspace_id: string } | null }

        if (member?.workspace_id) {
          return NextResponse.redirect(`${origin}/dashboard`)
        }
        return NextResponse.redirect(`${origin}/onboarding`)
      }
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_error`)
}
