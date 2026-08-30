import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/** Ask Kit stays unavailable until it is backed by scoped, authoritative data. */
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 })
  return NextResponse.json(
    { error: 'Ask Kit is not connected to authoritative project data yet.' },
    { status: 503, headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
  )
}
