// @ts-nocheck
/**
 * Onboarding — Harvest service
 *
 * Find or create the artist as a Harvest user (is_contractor=true), then
 * assign them to the Harvest project linked to the Kit project row.
 */

import type { OnboardingProject, ServiceResult } from '../types'
import {
  findOrCreateUser,
  assignUserToProject,
} from '../../../../src/lib/harvest/client'

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/)
  if (parts.length <= 1) return { firstName: parts[0] || '', lastName: '' }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  }
}

export async function inviteArtistToHarvest(opts: {
  project: OnboardingProject
  artistEmail: string
  artistName: string
  hourlyRate?: number
}): Promise<ServiceResult & { harvestUserId?: number }> {
  const { project, artistEmail, artistName, hourlyRate } = opts
  const harvestProjectId: number | undefined =
    project.external_links?.harvest_project_id
  if (!harvestProjectId) {
    return {
      status: 'skipped',
      message: 'project has no external_links.harvest_project_id',
    }
  }

  try {
    const { firstName, lastName } = splitName(artistName)
    const user = await findOrCreateUser({
      email: artistEmail,
      firstName: firstName || 'Freelancer',
      lastName: lastName || ' ',
      isContractor: true,
    })

    await assignUserToProject({
      projectId: harvestProjectId,
      userId: user.id,
      hourlyRate,
    })

    return {
      status: 'ok',
      message: `Assigned ${user.first_name} ${user.last_name} to Harvest project ${harvestProjectId}`,
      externalId: user.id,
      harvestUserId: user.id,
    }
  } catch (err: any) {
    return { status: 'failed', message: err.message || String(err) }
  }
}
