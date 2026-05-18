// @ts-nocheck
/**
 * Onboarding — Dropbox service
 *
 * Adds an artist as a member of the project's Dropbox folder.
 *
 * The project's Dropbox path lives in
 *   project.external_links.dropbox_path  (e.g. "/Ranger & Fox/Production/2026/2622_…")
 *
 * Flow:
 *   1. Look up (or create) the shared-folder id for the project path.
 *   2. /sharing/add_folder_member with the artist's email + 'editor' access.
 */

import type { OnboardingProject, ServiceResult } from '../types'
import { dropboxHeaders } from '../../../../src/lib/dropbox/client'

const DROPBOX_API = 'https://api.dropboxapi.com/2'

async function dbxPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${DROPBOX_API}${path}`, {
    method: 'POST',
    headers: await dropboxHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Dropbox ${path}: ${res.status} ${text}`)
  }
  return res.json()
}

/**
 * Get the shared_folder_id for a Dropbox path. If the folder isn't shared
 * yet, /sharing/share_folder makes it shared (async if large) and returns
 * the new id.
 */
async function getShareableFolderId(path: string): Promise<string> {
  // Try metadata first — gives shared_folder_id directly if already shared.
  const meta = await dbxPost('/files/get_metadata', {
    path,
    include_has_explicit_shared_members: true,
  })
  if (meta.shared_folder_id) return meta.shared_folder_id

  // Not yet shared — share it now. Returns either complete or async_job_id.
  const shared = await dbxPost('/sharing/share_folder', { path })
  if (shared['.tag'] === 'complete' && shared.shared_folder_id) {
    return shared.shared_folder_id
  }
  // For async jobs, poll briefly. Most studio folders are small enough to
  // complete synchronously, but handle the async case defensively.
  if (shared['.tag'] === 'async_job_id' && shared.async_job_id) {
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const status = await dbxPost('/sharing/check_share_job_status', {
        async_job_id: shared.async_job_id,
      })
      if (status['.tag'] === 'complete' && status.shared_folder_id) {
        return status.shared_folder_id
      }
    }
    throw new Error('share_folder still in_progress after 6s — try again')
  }
  throw new Error(`share_folder unexpected response: ${JSON.stringify(shared)}`)
}

export async function inviteArtistToDropbox(opts: {
  project: OnboardingProject
  artistEmail: string
}): Promise<ServiceResult> {
  const { project, artistEmail } = opts
  const dropboxPath: string | undefined = project.external_links?.dropbox_path
  if (!dropboxPath) {
    return {
      status: 'skipped',
      message: 'project has no external_links.dropbox_path',
    }
  }

  try {
    const sharedFolderId = await getShareableFolderId(dropboxPath)

    await dbxPost('/sharing/add_folder_member', {
      shared_folder_id: sharedFolderId,
      members: [
        {
          member: { '.tag': 'email', email: artistEmail },
          access_level: { '.tag': 'editor' },
        },
      ],
      quiet: false,
      custom_message: `You've been added to the ${project.name} project folder.`,
    })

    return {
      status: 'ok',
      message: `Added ${artistEmail} as editor on ${dropboxPath}`,
      externalId: sharedFolderId,
    }
  } catch (err: any) {
    // 'email_unverified' or 'invite_email' errors are common — surface as failed
    return { status: 'failed', message: err.message || String(err) }
  }
}
