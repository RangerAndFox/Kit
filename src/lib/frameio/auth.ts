/**
 * Adobe IMS OAuth — Refresh-Token Flow for Frame.io v4
 *
 * Frame.io v4 (post-Adobe acquisition) authenticates via Adobe IMS access
 * tokens, not the legacy v2 developer tokens. We exchange a long-lived
 * refresh token for short-lived access tokens and cache them in memory until
 * just before expiry.
 *
 * Required env vars:
 *   ADOBE_CLIENT_ID        — Adobe Developer Console project client ID
 *   ADOBE_CLIENT_SECRET    — Adobe Developer Console project client secret
 *   ADOBE_REFRESH_TOKEN    — long-lived IMS refresh token
 *   ADOBE_IMS_SCOPES       — (optional) space-separated scope list; defaults
 *                            to the standard Frame.io scope bundle
 */

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3'

const DEFAULT_SCOPES = [
  'openid',
  'AdobeID',
  'frame.s2s.all',
  'additional_info.roles',
  'offline_access',
].join(' ')

interface CachedToken {
  accessToken: string
  expiresAt: number // epoch ms
}

let cached: CachedToken | null = null
let inflight: Promise<string> | null = null

/**
 * Refresh an IMS access token using the configured refresh token.
 * Returns the raw token response from Adobe.
 */
async function fetchAccessToken(): Promise<{ access_token: string; expires_in: number }> {
  const clientId = process.env.ADOBE_CLIENT_ID
  const clientSecret = process.env.ADOBE_CLIENT_SECRET
  const refreshToken = process.env.ADOBE_REFRESH_TOKEN
  const scope = process.env.ADOBE_IMS_SCOPES || DEFAULT_SCOPES

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Adobe IMS not configured: set ADOBE_CLIENT_ID, ADOBE_CLIENT_SECRET, ADOBE_REFRESH_TOKEN'
    )
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    scope,
  })

  const res = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Adobe IMS token refresh failed: ${res.status} ${text}`)
  }

  return res.json() as Promise<{ access_token: string; expires_in: number }>
}

/**
 * Return a valid Frame.io v4 access token, refreshing if needed.
 * Caches the token in memory until 60s before expiry.
 * De-dupes concurrent callers via an in-flight promise.
 */
export async function getFrameIoAccessToken(): Promise<string> {
  const now = Date.now()
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.accessToken
  }

  if (inflight) return inflight

  inflight = (async () => {
    try {
      const { access_token, expires_in } = await fetchAccessToken()
      cached = {
        accessToken: access_token,
        expiresAt: now + expires_in * 1000,
      }
      return access_token
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/**
 * Build a fully-formed Authorization header for Frame.io v4 requests.
 */
export async function frameIoAuthHeaders(): Promise<Record<string, string>> {
  const token = await getFrameIoAccessToken()
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

/**
 * Test-only: clear the cached token. Not exported for production callers.
 */
export function __resetFrameIoTokenCache() {
  cached = null
  inflight = null
}
