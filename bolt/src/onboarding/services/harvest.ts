// @ts-nocheck
/**
 * Onboarding — Harvest service (Bucket-user mode)
 *
 * Ranger & Fox runs Harvest at its seat cap, so we don't create a
 * per-freelancer Harvest user. Instead, ONE shared bucket user
 * ("Freelancers") is reused — producers log freelancer hours against
 * that user with the actual person's name in the notes field.
 *
 * This service just ensures the bucket user is assigned to the project
 * (idempotent), so producers have it as a selectable user when logging
 * time. Per-person reporting happens via grep on the notes column.
 *
 * Configuration:
 *   HARVEST_FREELANCER_USER_ID — Harvest user_id of the bucket account.
 *
 * If the env var isn't set, this service returns 'skipped' with a clear
 * setup hint. If a future Harvest plan upgrade unlocks more seats, we
 * can swap this back to per-freelancer users.
 */

import type { OnboardingProject, ServiceResult } from '../types'
import { assignUserToProject } from '../../../../src/lib/harvest/client'

export async function inviteArtistToHarvest(opts: {
  project: OnboardingProject
  artistEmail: string
  artistName: string
  hourlyRate?: number
}): Promise<ServiceResult & { harvestUserId?: number }> {
  const { project, artistName } = opts
  // Kit's Harvest provisioner stores the project id as external_links.harvest_id.
  const rawHarvestId =
    project.external_links?.harvest_id ||
    project.external_links?.harvest_project_id
  const harvestProjectId = rawHarvestId ? Number(rawHarvestId) : NaN
  if (!harvestProjectId || Number.isNaN(harvestProjectId)) {
    return {
      status: 'skipped',
      message: 'project has no external_links.harvest_id',
    }
  }

  const bucketUserIdRaw = process.env.HARVEST_FREELANCER_USER_ID
  if (!bucketUserIdRaw) {
    return {
      status: 'skipped',
      message:
        'HARVEST_FREELANCER_USER_ID not set — configure the shared freelancers user in Railway to enable Harvest assignment.',
    }
  }
  const bucketUserId = Number(bucketUserIdRaw)
  if (Number.isNaN(bucketUserId)) {
    return {
      status: 'skipped',
      message: `HARVEST_FREELANCER_USER_ID is not numeric: ${bucketUserIdRaw}`,
    }
  }

  try {
    await assignUserToProject({ projectId: harvestProjectId, userId: bucketUserId })
    return {
      status: 'ok',
      message:
        `Freelancers bucket user assigned to Harvest project ${harvestProjectId}. ` +
        `Log ${artistName}'s hours under that user with their name in the notes.`,
      externalId: bucketUserId,
      harvestUserId: bucketUserId,
    }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err) }
  }
}
