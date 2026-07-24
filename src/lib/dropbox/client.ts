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

/** Single-flight guard — concurrent expiry shares one token exchange. */
let refreshInFlight: Promise<CachedToken> | null = null

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

  // Fetch a fresh token — single-flight so concurrent expiry doesn't fire
  // N parallel token exchanges.
  if (!refreshInFlight) {
    refreshInFlight = fetchFreshToken().finally(() => {
      refreshInFlight = null
    })
  }
  cached = await refreshInFlight
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

/** Base URL for Dropbox RPC-style endpoints (list_folder, etc.). */
const DROPBOX_RPC_API = 'https://api.dropboxapi.com/2'

/**
 * POST to a Dropbox RPC endpoint with auth headers, JSON body, and a
 * timeout. Shared by the delivery watchers (was duplicated verbatim in
 * dropbox-watcher.ts and specs-watcher.ts).
 *
 * On an AbortSignal.timeout() fire, native fetch rejects with a bare
 * `TimeoutError` DOMException whose message is only "The operation was aborted
 * due to timeout." — no endpoint, no budget, no provider. That opaque string is
 * exactly what surfaced in production. We wrap the abort with the endpoint +
 * timeout it happened on while preserving the original DOMException as `cause`.
 * Only the endpoint path (e.g. "/files/list_folder") and the numeric budget are
 * included — never headers, tokens, or the request body.
 */
export async function dropboxRpc(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<any> {
  let res: Response
  try {
    res = await fetch(`${DROPBOX_RPC_API}${endpoint}`, {
      method: 'POST',
      headers: await dropboxHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const name = (err as { name?: string } | null)?.name
    // AbortSignal.timeout → TimeoutError; a manual abort → AbortError. Either
    // way, attribute it to this endpoint + budget and keep the original cause.
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`Dropbox ${endpoint} timed out after ${timeoutMs}ms`, { cause: err })
    }
    // Network/DNS/TLS failures: still opaque without the endpoint. Attribute
    // them too, preserving the cause.
    const message = (err as { message?: string } | null)?.message
    throw new Error(`Dropbox ${endpoint} request failed: ${message || String(err)}`, { cause: err })
  }
  if (!res.ok) {
    throw new Error(`Dropbox ${endpoint} ${res.status}: ${await res.text().catch(() => '')}`)
  }
  return res.json()
}

/** Reset token cache — used in tests */
export function _resetDropboxTokenCacheForTest(): void {
  cached = null
}
