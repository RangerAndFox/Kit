/**
 * Dropbox client with OAuth refresh-token flow.
 *
 * Dropbox short-lived access tokens last ~4 hours. With OAuth refresh-token
 * flow we exchange (app_key, app_secret, refresh_token) for a fresh access
 * token automatically — no manual rotation.
 *
 * Required env vars:
 *   DROPBOX_APP_KEY       — Dropbox app key (visible at dropbox.com/developers)
 *   DROPBOX_APP_SECRET    — Dropbox app secret (Show at dropbox.com/developers)
 *   DROPBOX_REFRESH_TOKEN — Long-lived refresh token (one-time setup, see scripts/dropbox-refresh-token.ts)
 *
 * Backwards compat: if DROPBOX_ACCESS_TOKEN is set and the three refresh
 * vars aren't, we fall back to the static token (which expires in ~4h).
 */

const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'

interface CachedToken {
  accessToken: string
  /** Unix ms when this token expires (with safety buffer) */
  expiresAt: number
}

let cached: CachedToken | null = null

/** Refresh slightly before actual expiry */
const SAFETY_BUFFER_MS = 5 * 60 * 1000 // refresh 5 min early

async function fetchFreshToken(): Promise<CachedToken> {
  const appKey = process.env.DROPBOX_APP_KEY
  const appSecret = process.env.DROPBOX_APP_SECRET
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN

  if (!appKey || !appSecret || !refreshToken) {
    throw new Error(
      'Dropbox refresh-token flow requires DROPBOX_APP_KEY, DROPBOX_APP_SECRET, and DROPBOX_REFRESH_TOKEN',
    )
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  const auth = Buffer.from(`${appKey}:${appSecret}`).toString('base64')

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Dropbox token exchange failed: ${res.status} ${errText}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - SAFETY_BUFFER_MS,
  }
}

/**
 * Returns a valid Dropbox access token, refreshing via OAuth if needed.
 * Falls back to static DROPBOX_ACCESS_TOKEN if refresh creds aren't set.
 */
export async function getDropboxAccessToken(): Promise<string> {
  // Backwards compat: if no refresh creds and there's a static token, use it
  const hasRefreshCreds =
    !!process.env.DROPBOX_APP_KEY &&
    !!process.env.DROPBOX_APP_SECRET &&
    !!process.env.DROPBOX_REFRESH_TOKEN

  if (!hasRefreshCreds) {
    const staticToken = process.env.DROPBOX_ACCESS_TOKEN
    if (!staticToken) {
      throw new Error(
        'No Dropbox credentials configured. Set DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN, or fall back to DROPBOX_ACCESS_TOKEN.',
      )
    }
    return staticToken
  }

  // Use cache if still valid
  if (cached && Date.now() < cached.expiresAt) {
    return cached.accessToken
  }

  // Fetch a fresh token
  cached = await fetchFreshToken()
  return cached.accessToken
}

/** Headers helper for Dropbox API calls */
export async function dropboxHeaders(): Promise<Record<string, string>> {
  const token = await getDropboxAccessToken()
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

/** Reset token cache — used in tests */
export function _resetDropboxTokenCacheForTest(): void {
  cached = null
}
