// @ts-nocheck
/**
 * Frame.io Auth — Adobe IMS OAuth Refresh Token Flow
 *
 * Frame.io is now an Adobe product. API auth goes through Adobe IMS:
 *   1. One-time: user authorizes via browser → get refresh_token
 *   2. Runtime: exchange refresh_token for short-lived access_token
 *   3. Access tokens expire in ~1 hour, refresh tokens last ~14 days
 *      but are renewed each time they're used (rolling window).
 *
 * Persistence note: Adobe rotates the refresh token on every successful
 * exchange. We persist the latest rotated value in the Supabase
 * `frameio_token_state` (singleton row) so container restarts don't lose
 * it — without persistence, restarts force a fallback to the original
 * env-var token, which Adobe has already invalidated → access_denied.
 *
 * Required env vars:
 *   FRAMEIO_ADOBE_CLIENT_ID     — Adobe Developer Console client ID
 *   FRAMEIO_ADOBE_CLIENT_SECRET — Adobe Developer Console client secret
 *   FRAMEIO_ADOBE_REFRESH_TOKEN — Initial refresh token (bootstrap only;
 *                                 after first exchange the rotated value
 *                                 is read from Supabase)
 *
 * Backwards compat: if FRAMEIO_TOKEN is set and Adobe vars aren't,
 * falls back to the static Frame.io developer token.
 */

import { createAdminClient } from '../supabase/admin'

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3'

interface CachedToken {
  accessToken: string
  /** New refresh token (Adobe rotates on each exchange) */
  refreshToken: string
  /** Unix ms when this access token expires */
  expiresAt: number
}

let cached: CachedToken | null = null

/** Refresh 5 minutes before actual expiry */
const SAFETY_BUFFER_MS = 5 * 60 * 1000

async function loadPersistedRefreshToken(): Promise<string | null> {
  try {
    const sb = createAdminClient()
    const { data } = await sb
      .from('frameio_token_state')
      .select('refresh_token')
      .eq('id', 'singleton')
      .maybeSingle()
    return data?.refresh_token || null
  } catch (err: any) {
    console.warn(`[FrameIO] could not load persisted refresh token: ${err.message}`)
    return null
  }
}

async function persistRefreshToken(refreshToken: string): Promise<void> {
  try {
    const sb = createAdminClient()
    await sb
      .from('frameio_token_state')
      .update({ refresh_token: refreshToken, updated_at: new Date().toISOString() })
      .eq('id', 'singleton')
  } catch (err: any) {
    console.warn(`[FrameIO] could not persist rotated refresh token: ${err.message}`)
  }
}

async function fetchFreshToken(): Promise<CachedToken> {
  const clientId = process.env.FRAMEIO_ADOBE_CLIENT_ID
  const clientSecret = process.env.FRAMEIO_ADOBE_CLIENT_SECRET

  // Preference order for the refresh token:
  //   1. In-memory cached rotation (fastest, set on previous exchange)
  //   2. Supabase persisted rotation (survives container restarts)
  //   3. Env-var bootstrap token (one-time only — Adobe rotates this away
  //      on first successful exchange)
  let refreshToken: string | null | undefined = cached?.refreshToken
  if (!refreshToken) refreshToken = await loadPersistedRefreshToken()
  if (!refreshToken) refreshToken = process.env.FRAMEIO_ADOBE_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Frame.io Adobe OAuth requires FRAMEIO_ADOBE_CLIENT_ID, FRAMEIO_ADOBE_CLIENT_SECRET, and FRAMEIO_ADOBE_REFRESH_TOKEN',
    )
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  })

  const res = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Adobe IMS token exchange failed: ${res.status} ${errText}`)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  // Persist the rotated refresh token so we don't lose it on restart.
  await persistRefreshToken(data.refresh_token)

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - SAFETY_BUFFER_MS,
  }
}

/**
 * Returns a valid Frame.io access token, refreshing via Adobe IMS if needed.
 * Falls back to static FRAMEIO_TOKEN if Adobe creds aren't configured.
 */
export async function getFrameIoAccessToken(): Promise<string> {
  const hasAdobeCreds =
    !!process.env.FRAMEIO_ADOBE_CLIENT_ID &&
    !!process.env.FRAMEIO_ADOBE_CLIENT_SECRET &&
    !!process.env.FRAMEIO_ADOBE_REFRESH_TOKEN

  if (!hasAdobeCreds) {
    const staticToken = process.env.FRAMEIO_TOKEN
    if (!staticToken) {
      throw new Error(
        'No Frame.io credentials configured. Set FRAMEIO_ADOBE_CLIENT_ID + FRAMEIO_ADOBE_CLIENT_SECRET + FRAMEIO_ADOBE_REFRESH_TOKEN, or fall back to FRAMEIO_TOKEN.',
      )
    }
    return staticToken
  }

  // Use cache if still valid
  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken
  }

  // Fetch fresh token
  cached = await fetchFreshToken()
  console.log('[FrameIO] Access token refreshed via Adobe IMS')
  return cached.accessToken
}

/** Headers helper for Frame.io API calls */
export async function frameioHeaders(): Promise<Record<string, string>> {
  const token = await getFrameIoAccessToken()
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

/** Reset token cache — used in tests */
export function _resetFrameIoTokenCacheForTest(): void {
  cached = null
}
