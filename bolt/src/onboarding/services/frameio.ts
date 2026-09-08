/**
 * Onboarding — Frame.io service (v4)
 *
 * v4 doesn't have a /collaborators endpoint. The correct flow is:
 *   1. Resolve the user by email:
 *      GET /accounts/{acct}/users?filter[email]={email}
 *   2. PATCH the project's user with a project role:
 *      PATCH /accounts/{acct}/projects/{id}/users/{user_id}
 *      body: { data: { role: 'editor' } }
 *
 * Project permissions cover the project's root folder and everything beneath
 * it, so this is the Frame.io equivalent of adding the freelancer to the
 * project's Frame folder. We default to `editor`: enough to upload and work
 * with project media without granting project-admin/full-access privileges.
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

export const FRAMEIO_PROJECT_ROLES = [
  'full_access',
  'editor',
  'edit_only',
  'commenter',
  'viewer',
] as const

export type FrameIoProjectRole = typeof FRAMEIO_PROJECT_ROLES[number]

export function resolveFreelancerFrameIoRole(value?: string): FrameIoProjectRole {
  const candidate = (value || 'editor').trim().toLowerCase()
  if ((FRAMEIO_PROJECT_ROLES as readonly string[]).includes(candidate)) {
    return candidate as FrameIoProjectRole
  }
  throw new Error(
    `Invalid FRAMEIO_FREELANCER_PROJECT_ROLE "${value}"; expected one of ${FRAMEIO_PROJECT_ROLES.join(', ')}`,
  )
}

export function buildFrameIoProjectAccessRequest(opts: {
  accountId: string
  projectId: string
  userId: string
  role: FrameIoProjectRole
  headers: Record<string, string>
}): { url: string; init: RequestInit } {
  return {
    url: `${FRAMEIO_API}/accounts/${opts.accountId}/projects/${opts.projectId}/users/${opts.userId}`,
    init: {
      method: 'PATCH',
      headers: opts.headers,
      body: JSON.stringify({ data: { role: opts.role } }),
      signal: AbortSignal.timeout(15_000),
    },
  }
}

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
      // Frame.io v4 has no email-invite endpoint (Adobe removed it from v2).
      // Best path is the person self-signs up; then re-running onboarding
      // finds them and PATCHes the project. We pre-fill a signup URL and
      // also bubble it up as an actionUrl so the welcome message can
      // surface it directly to the freelancer in the Connect channel.
      const signupUrl =
        `https://next.frame.io/signup?email=${encodeURIComponent(artistEmail)}`
      return {
        status: 'failed',
        message:
          `${artistEmail} isn't in our Frame.io account yet. Self-signup link sent to them in the project channel; once they accept and sign up, re-run \`@Kit onboard\` to grant project access.`,
        actionUrl: signupUrl,
        actionLabel: 'Sign up for Frame.io',
      }
    }

    const role = resolveFreelancerFrameIoRole(process.env.FRAMEIO_FREELANCER_PROJECT_ROLE)
    const hdrs = await frameioHeaders()
    const request = buildFrameIoProjectAccessRequest({
      accountId: acct,
      projectId: frameioId,
      userId,
      role,
      headers: hdrs,
    })
    // PATCH is intentionally idempotent: re-running onboarding updates the
    // person's role rather than creating a duplicate project collaborator.
    const res = await fetch(request.url, request.init)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`PATCH project user ${res.status}: ${text}`)
    }
    return {
      status: 'ok',
      message: `Added ${artistEmail} to ${project.name}'s Frame.io project folder with ${role} access.`,
      externalId: userId,
    }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err) }
  }
}
