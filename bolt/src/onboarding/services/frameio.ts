// @ts-nocheck
/**
 * Onboarding — Frame.io service (v4)
 *
 * Invites an artist as a collaborator on the project's Frame.io v4 project.
 *
 * The exact v4 endpoint name moved around during Adobe's migration. Best
 * guess is /v4/accounts/{acct}/projects/{id}/collaborators. If this comes
 * back 404 in practice, the alternatives to try are /team, /invitations,
 * or /members.
 */

import type { OnboardingProject, ServiceResult } from '../types'
import { frameioHeaders } from '../../../../src/lib/frameio/auth'

const FRAMEIO_API = 'https://api.frame.io/v4'

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
    const hdrs = await frameioHeaders()
    const res = await fetch(
      `${FRAMEIO_API}/accounts/${acct}/projects/${frameioId}/collaborators`,
      {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({
          data: { email: artistEmail, role: 'collaborator' },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // 409 / 422 usually means already a collaborator — count as ok.
      if (res.status === 409 || /already/i.test(text)) {
        return {
          status: 'ok',
          message: `Already a collaborator on ${project.name}`,
        }
      }
      throw new Error(`${res.status} ${text}`)
    }
    const data = await res.json()
    const externalId = data?.data?.id || data?.id
    return {
      status: 'ok',
      message: `Invited ${artistEmail} as collaborator on Frame.io project ${frameioId}`,
      externalId,
    }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err) }
  }
}
