// @ts-nocheck
/**
 * Onboarding — Frame.io service (v4)
 *
 * v4 doesn't have a /collaborators endpoint. The correct flow is:
 *   1. Resolve the user by email:
 *      GET /accounts/{acct}/users?filter[email]={email}
 *   2. PATCH the project's user with a role:
 *      PATCH /accounts/{acct}/projects/{id}/users/{user_id}
 *      body: { data: { role: 'team_member' } }
 *
 * If the user isn't already in our Frame.io account, the GET returns
 * nothing — that means they need to be invited at the account/workspace
 * level first. v4 does not (yet) appear to expose a public email-invite
 * endpoint, so for now we return 'failed' with a clear message and let
 * the PM invite manually in Frame.io.
 */

import type { OnboardingProject, ServiceResult } from '../types'
import { frameioHeaders } from '../../../../src/lib/frameio/auth'

const FRAMEIO_API = 'https://api.frame.io/v4'

/**
 * Look up a Frame.io v4 user by email.
 *
 * v4's GET /accounts/{acct}/users does NOT support email filtering — the
 * only supported query params are sort, after, page_size, etc. We have
 * to paginate and match client-side. Sorted by email_asc so most lookups
 * complete within the first page.
 */
async function lookupFrameIoUserByEmail(
  accountId: string,
  email: string,
): Promise<string | null> {
  const target = email.toLowerCase()
  let after: string | undefined
  // Cap at 10 pages (1000 users) so a misconfigured account doesn't loop forever.
  for (let page = 0; page < 10; page++) {
    const hdrs = await frameioHeaders()
    const qs = new URLSearchParams({ sort: 'email_asc', page_size: '100' })
    if (after) qs.set('after', after)
    const url = `${FRAMEIO_API}/accounts/${accountId}/users?${qs.toString()}`
    const res = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`user lookup ${res.status}: ${text}`)
    }
    const data = await res.json()
    const list = data?.data || []
    if (Array.isArray(list)) {
      for (const u of list) {
        const e = (u?.email || u?.attributes?.email || '').toLowerCase()
        if (e === target) return u.id
      }
    }
    after = data?.links?.next?.after || data?.meta?.next_cursor || undefined
    if (!after) break
  }
  return null
}

export async function inviteArtistToFrameIo(opts: {
  project: OnboardingProject
  artistEmail: string
}): Promise<ServiceResult> {
  const { project, artistEmail } = opts
  const acct = process.env.FRAMEIO_ACCOUNT_ID
  if (!acct) {
    return { status: 'skipped', message: 'FRAMEIO_ACCOUNT_ID not set' }
  }

  const frameioId: string | undefined =
    project.external_links?.frameio_id ||
    project.external_links?.frameio_project_id
  if (!frameioId) {
    return {
      status: 'skipped',
      message: 'project has no external_links.frameio_id',
    }
  }

  try {
    const userId = await lookupFrameIoUserByEmail(acct, artistEmail)
    if (!userId) {
      return {
        status: 'failed',
        message:
          `${artistEmail} isn't in our Frame.io account yet — invite them via Frame.io's web UI first, then re-run onboarding for this artist.`,
      }
    }

    const hdrs = await frameioHeaders()
    const res = await fetch(
      `${FRAMEIO_API}/accounts/${acct}/projects/${frameioId}/users/${userId}`,
      {
        method: 'PATCH',
        headers: hdrs,
        body: JSON.stringify({ data: { role: 'team_member' } }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`PATCH project user ${res.status}: ${text}`)
    }
    return {
      status: 'ok',
      message: `Granted ${artistEmail} team_member access on Frame.io project ${frameioId}`,
      externalId: userId,
    }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err) }
  }
}
