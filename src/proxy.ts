import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { contentSecurityPolicy } from './lib/security/csp'

export default async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development')
  request.headers.set('x-nonce', nonce)
  request.headers.set('Content-Security-Policy', policy)
  const secure = (response: NextResponse) => {
    response.headers.set('Content-Security-Policy', policy)
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }
  let supabaseResponse = secure(NextResponse.next({ request: { headers: request.headers } }))

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = secure(NextResponse.next({ request: { headers: request.headers } }))
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname

  // API routes handle their own auth — don't redirect
  if (path.startsWith('/api/')) {
    return supabaseResponse
  }

  // Public routes — don't require auth
  if (path === '/login' || path === '/auth/callback' || path === '/') {
    if (user && path === '/login') {
      const url = request.nextUrl.clone()
      url.pathname = '/control-center'
      return secure(NextResponse.redirect(url))
    }
    return supabaseResponse
  }

  // Protected routes — redirect to login if not authenticated
  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return secure(NextResponse.redirect(url))
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
