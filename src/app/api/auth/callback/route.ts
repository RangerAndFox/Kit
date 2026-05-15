/**
 * Adobe IMS OAuth callback for Frame.io.
 *
 * Configured in the Adobe Developer Console as the redirect URI for the
 * Frame.io OAuth Web App credential. The Bolt server uses
 * `src/lib/frameio/auth.ts` to refresh access tokens, which depends on a
 * valid refresh_token persisted in Supabase `frameio_token_state`.
 *
 * Flow:
 *   1. Operator visits a one-time authorize URL in their browser (see
 *      FEATURES.md or the README for how to construct it). Example:
 *      https://ims-na1.adobelogin.com/ims/authorize/v2
 *        ?client_id=<FRAMEIO_ADOBE_CLIENT_ID>
 *        &scope=email,openid,offline_access,additional_info.roles,profile
 *        &response_type=code
 *        &redirect_uri=https://kit-amber.vercel.app/api/auth/callback
 *   2. Adobe authenticates the operator, then redirects here with `?code=...`
 *   3. This handler exchanges the code for {access_token, refresh_token}
 *      and persists the refresh_token into Supabase. The Bolt server picks
 *      it up on its next refresh cycle.
 *
 * This route is intentionally not behind app auth because Adobe's
 * authorize step is the gate — without valid Adobe credentials, no code
 * can be issued.
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  if (error) {
    return new NextResponse(
      `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;padding:0 20px"><h1>Adobe IMS authorization failed</h1><p>Error: <code>${error}</code></p><p>Description: ${url.searchParams.get('error_description') || '(none)'}</p></body></html>`,
      { status: 400, headers: { 'Content-Type': 'text/html' } },
    )
  }

  if (!code) {
    return new NextResponse(
      '<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;padding:0 20px"><h1>Missing authorization code</h1><p>Adobe IMS did not return a <code>code</code> parameter. Re-start the OAuth flow.</p></body></html>',
      { status: 400, headers: { 'Content-Type': 'text/html' } },
    )
  }

  const clientId = process.env.FRAMEIO_ADOBE_CLIENT_ID
  const clientSecret = process.env.FRAMEIO_ADOBE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return new NextResponse(
      '<!doctype html><html><body style="font-family:sans-serif"><h1>Server misconfigured</h1><p>FRAMEIO_ADOBE_CLIENT_ID and/or FRAMEIO_ADOBE_CLIENT_SECRET not set in this environment.</p></body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    )
  }

  // Adobe IMS requires the same redirect_uri here that was used in the
  // authorize step. Use the request's own URL host so this works in dev
  // and prod automatically.
  const redirectUri = `${url.origin}/api/auth/callback`

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  })

  let tokens: { access_token: string; refresh_token: string; expires_in: number }
  try {
    const res = await fetch(IMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) {
      const errText = await res.text()
      return new NextResponse(
        `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;padding:0 20px"><h1>Token exchange failed</h1><p>Adobe IMS returned <code>${res.status}</code></p><pre style="background:#f4f4f4;padding:12px;overflow:auto">${errText}</pre></body></html>`,
        { status: 502, headers: { 'Content-Type': 'text/html' } },
      )
    }
    tokens = (await res.json()) as typeof tokens
  } catch (err: any) {
    return new NextResponse(
      `<!doctype html><html><body style="font-family:sans-serif"><h1>Network error</h1><p>${err.message}</p></body></html>`,
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    )
  }

  // Persist the refresh_token so the Bolt server can pick it up.
  try {
    const sb = createAdminClient()
    await sb
      .from('frameio_token_state')
      .upsert(
        {
          id: 'singleton',
          refresh_token: tokens.refresh_token,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' },
      )
  } catch (err: any) {
    return new NextResponse(
      `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;padding:0 20px"><h1>Got tokens but Supabase write failed</h1><p>${err.message}</p><p>You can paste this refresh token into the <code>FRAMEIO_ADOBE_REFRESH_TOKEN</code> Railway env var as a fallback:</p><pre style="background:#f4f4f4;padding:12px;overflow:auto;word-break:break-all;white-space:pre-wrap">${tokens.refresh_token}</pre></body></html>`,
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    )
  }

  return new NextResponse(
    `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:60px auto;padding:0 20px"><h1>✅ Frame.io auth restored</h1><p>Refresh token written to Supabase <code>frameio_token_state</code>. The Bolt server will pick it up on its next Frame.io call (no redeploy needed).</p><p style="color:#888;font-size:14px">Access token expires in ${tokens.expires_in}s — Adobe rotates the refresh token on every exchange, and the rotation is now persisted across restarts.</p></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } },
  )
}
