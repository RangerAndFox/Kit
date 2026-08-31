// @ts-nocheck
/**
 * Frame.io Auth — Adobe IMS OAuth Refresh Token Flow (cross-runtime coordinated)
 *
 * Frame.io is an Adobe product; API auth goes through Adobe IMS. Adobe ROTATES the
 * refresh token on every exchange, returning a new one. Kit runs this code in more
 * than one runtime at once — the Vercel Next.js app (incl. the /status poller and
 * Inngest jobs) and the Railway Bolt service. The previous design gave each runtime
 * its own in-memory copy of the refresh token and let each refresh independently, so
 * whenever one runtime exchanged, Adobe invalidated the token every OTHER runtime was
 * holding → the loser's next exchange failed with `400 {"error":"access_denied"}`.
 * That is why `/v4/me` (whichever runtime just rotated) could be green while project
 * provisioning (a different, now-poisoned runtime) failed on every attempt.
 *
 * The fix, using only Supabase (no Adobe Server-to-Server licence required):
 *   1. Share the ACCESS token, not just the refresh token. Access tokens last ~1h,
 *      so all runtimes read one shared token from `frameio_token_state` and almost
 *      never exchange.
 *   2. Serialise the exchange with a DB lock (`refreshing_until`, claimed by an
 *      atomic conditional UPDATE). Exactly one runtime exchanges at a time; the rest
 *      wait and read the freshly-persisted access token. No two runtimes ever present
 *      the same rotating refresh token, so nothing gets rotated out from under anyone.
 *   3. NEVER prefer an in-memory refresh token over the persisted one. The refresh
 *      token lives only in the DB; in-memory caching is limited to the short-lived
 *      access token (a pure read optimisation, safe because it is shared and expiring).
 *
 * Required env vars:
 *   FRAMEIO_ADOBE_CLIENT_ID     — Adobe Developer Console client ID
 *   FRAMEIO_ADOBE_CLIENT_SECRET — Adobe Developer Console client secret
 *   FRAMEIO_ADOBE_REFRESH_TOKEN — Initial refresh token (bootstrap only; after the
 *                                 first exchange the rotated value lives in Supabase)
 *
 * Backwards compat: if FRAMEIO_TOKEN is set and the Adobe vars aren't, falls back to
 * the static developer token.
 */

import { createAdminClient } from '../supabase/admin'

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3'

/** Refresh this many ms before the access token actually expires. */
const SAFETY_BUFFER_MS = 5 * 60 * 1000
/** How long a refresh lock is held before it is considered abandoned (crash-safe). */
const LOCK_TTL_MS = 30 * 1000
/** Max attempts to obtain a usable token (claim the lock, or read another runtime's result). */
const MAX_ATTEMPTS = 6
/** Base wait between attempts while another runtime is refreshing. */
const WAIT_MS = 750

interface AccessSnapshot {
  accessToken: string
  /** Unix ms when this access token should be treated as expired (buffer applied). */
  expiresAt: number
}

/**
 * In-memory cache of the ACCESS token ONLY. This is a read optimisation, never a
 * source of truth: it caches the same shared value every runtime sees, and it expires.
 * The refresh token is deliberately NOT cached in memory — that was the poison.
 */
let cachedAccess: AccessSnapshot | null = null

function hasAdobeCreds(): boolean {
  return (
    !!process.env.FRAMEIO_ADOBE_CLIENT_ID &&
    !!process.env.FRAMEIO_ADOBE_CLIENT_SECRET &&
    !!process.env.FRAMEIO_ADOBE_REFRESH_TOKEN
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface TokenRow {
  refresh_token: string | null
  access_token: string | null
  access_expires_at: string | null
  refreshing_until: string | null
}

interface RefreshLease {
  holder: string
  fence: number
}

async function readState(): Promise<TokenRow | null> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('frameio_token_state')
    .select('refresh_token, access_token, access_expires_at, refreshing_until')
    .eq('id', 'singleton')
    .maybeSingle()
  if (error) throw new Error(`frameio_token_state read failed: ${error.message}`)
  return (data as TokenRow) || null
}

/** A shared access token is usable if present and not within the safety buffer of expiry. */
function usableAccess(row: TokenRow | null): string | null {
  if (!row?.access_token || !row.access_expires_at) return null
  const expMs = Date.parse(row.access_expires_at)
  if (Number.isNaN(expMs)) return null
  if (Date.now() < expMs - SAFETY_BUFFER_MS) return row.access_token
  return null
}

/**
 * Atomically claim the right to refresh. A conditional UPDATE flips `refreshing_until`
 * from NULL/past to now()+TTL for the singleton row; Postgres row locking guarantees
 * only ONE concurrent caller wins (the losers' WHERE re-evaluates to false under the
 * row lock and updates zero rows). Returns true iff this caller holds the lock.
 */
async function claimRefreshLock(): Promise<RefreshLease | null> {
  const sb = createAdminClient()
  const holder = crypto.randomUUID()
  const { data, error } = await sb.rpc('claim_frameio_token_refresh', {
    p_holder: holder,
    p_lease_seconds: Math.ceil(LOCK_TTL_MS / 1000),
  })
  if (error) throw new Error(`frameio refresh-lock claim failed: ${error.message}`)
  const row = Array.isArray(data) ? data[0] : data
  return row?.claimed && Number.isFinite(Number(row.fence))
    ? { holder, fence: Number(row.fence) }
    : null
}

/**
 * Exchange the persisted refresh token for a new access token, and persist BOTH the
 * rotated refresh token and the new access token + expiry, releasing the lock in the
 * same write. The persist is NOT best-effort: if Adobe rotated the token but we failed
 * to store it, every runtime is now stranded on an invalidated token, so we throw
 * loudly rather than swallow it (the old code's silent-warn was a latent outage).
 */
async function exchangeAndPersist(lease: RefreshLease): Promise<AccessSnapshot> {
  const clientId = process.env.FRAMEIO_ADOBE_CLIENT_ID
  const clientSecret = process.env.FRAMEIO_ADOBE_CLIENT_SECRET

  // The refresh token comes from the DB (rotated), falling back to the env bootstrap
  // ONLY when the DB has none. In-memory is never consulted — that was the poison.
  const state = await readState()
  const refreshToken = state?.refresh_token || process.env.FRAMEIO_ADOBE_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Frame.io Adobe OAuth requires FRAMEIO_ADOBE_CLIENT_ID, FRAMEIO_ADOBE_CLIENT_SECRET, and a refresh token (DB or FRAMEIO_ADOBE_REFRESH_TOKEN).',
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
    const errText = await res.text().catch(() => '')
    // access_denied here now almost always means the persisted refresh token is
    // genuinely dead (Adobe expired it, or a persist was lost long ago) and a
    // one-time out-of-band token bootstrap is needed. The former browser callback
    // is intentionally disabled until it has operator auth + OAuth state.
    throw new Error(`Adobe IMS token exchange failed: ${res.status} ${errText}`)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
  }

  const accessExpiresAtIso = new Date(Date.now() + data.expires_in * 1000).toISOString()

  const sb = createAdminClient()
  const { data: finished, error } = await sb.rpc('finish_frameio_token_refresh', {
    p_holder: lease.holder,
    p_fence: lease.fence,
    p_refresh_token: data.refresh_token,
    p_access_token: data.access_token,
    p_access_expires_at: accessExpiresAtIso,
  })
  if (error || finished !== true) {
    // We rotated at Adobe but could not store the result. Do not swallow: the next
    // runtime would exchange an already-invalidated token. Surface it so it is fixed.
    throw new Error(
      `Frame.io token rotated at Adobe but the fenced Supabase persist FAILED (${error?.message || 'lease lost'}). ` +
        `The refresh token is now out of sync; reseed FRAMEIO_ADOBE_REFRESH_TOKEN through the approved secret-management path.`,
    )
  }

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000 - SAFETY_BUFFER_MS,
  }
}

/** Best-effort lock release, for the failure path (a successful exchange clears it inline). */
async function releaseLockQuietly(lease: RefreshLease): Promise<void> {
  try {
    const sb = createAdminClient()
    await sb.rpc('release_frameio_token_refresh', {
      p_holder: lease.holder,
      p_fence: lease.fence,
    })
  } catch {
    /* the TTL will free it anyway */
  }
}

/**
 * Returns a valid Frame.io access token, coordinating refresh across every runtime.
 * Falls back to a static FRAMEIO_TOKEN if Adobe creds aren't configured.
 */
export async function getFrameIoAccessToken(): Promise<string> {
  if (!hasAdobeCreds()) {
    const staticToken = process.env.FRAMEIO_TOKEN
    if (!staticToken) {
      throw new Error(
        'No Frame.io credentials configured. Set FRAMEIO_ADOBE_CLIENT_ID + FRAMEIO_ADOBE_CLIENT_SECRET + FRAMEIO_ADOBE_REFRESH_TOKEN, or fall back to FRAMEIO_TOKEN.',
      )
    }
    return staticToken
  }

  // Fast path: our own in-memory copy of the shared access token is still good.
  if (cachedAccess && Date.now() < cachedAccess.expiresAt) return cachedAccess.accessToken

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // 1. Is a valid shared access token already sitting in the DB?
    const state = await readState()
    const shared = usableAccess(state)
    if (shared) {
      const expMs = Date.parse(state!.access_expires_at as string)
      cachedAccess = { accessToken: shared, expiresAt: expMs - SAFETY_BUFFER_MS }
      return shared
    }

    // 2. It needs refreshing. Try to become the one runtime that does it.
    let lease: RefreshLease | null = null
    try {
      lease = await claimRefreshLock()
    } catch (err: any) {
      // If even claiming fails (transient DB error), fall through to a short wait.
      console.warn(`[FrameIO] lock claim error: ${err.message}`)
    }

    if (lease) {
      try {
        // Re-check: another runtime may have refreshed between our read and our claim.
        const fresh = await readState()
        const freshShared = usableAccess(fresh)
        if (freshShared) {
          const expMs = Date.parse(fresh!.access_expires_at as string)
          cachedAccess = { accessToken: freshShared, expiresAt: expMs - SAFETY_BUFFER_MS }
          return freshShared
        }
        const snap = await exchangeAndPersist(lease) // clears this exact lease inline on success
        cachedAccess = snap
        console.log('[FrameIO] Access token refreshed via Adobe IMS (coordinated)')
        return snap.accessToken
      } catch (err) {
        await releaseLockQuietly(lease) // only this exact holder/fence may release
        throw err
      }
    }

    // 3. Someone else holds the lock. Wait a little and re-read their result.
    await sleep(WAIT_MS * (attempt + 1))
  }

  // Exhausted attempts without a usable token: last read, else surface clearly.
  const last = await readState()
  const lastShared = usableAccess(last)
  if (lastShared) return lastShared
  throw new Error(
    'Frame.io access token unavailable after coordinated-refresh retries (a refresh is stuck or the refresh token must be reseeded through the approved secret-management path).',
  )
}

/** Headers helper for Frame.io API calls */
export async function frameioHeaders(): Promise<Record<string, string>> {
  const token = await getFrameIoAccessToken()
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

/** Reset in-memory access cache — used in tests. */
export function _resetFrameIoTokenCacheForTest(): void {
  cachedAccess = null
}
