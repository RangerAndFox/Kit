// @ts-nocheck
/**
 * Shared types for freelancer onboarding.
 */

export interface OnboardingInput {
  /** Supabase project row id */
  projectId: string
  artistEmail: string
  artistName: string
  /** Slack user id of the PM / CD requesting the onboarding */
  requestedBy: string
}

export interface OnboardingProject {
  id: string
  name: string
  client: string | null
  project_code: string | null
  brief_summary: string | null
  target_delivery: string | null
  external_links: Record<string, any> | null
  external_ids: Record<string, any> | null
}

export type ServiceStatus = 'pending' | 'ok' | 'failed' | 'skipped'

export interface ServiceResult {
  status: ServiceStatus
  message: string
  /** External ref returned by the service (e.g. Harvest user id) */
  externalId?: string | number
  /** Slack user id, only filled by the Slack service */
  slackUserId?: string
  /**
   * A URL the artist must visit to complete onboarding for this service
   * (e.g. Frame.io self-signup). Surfaced in the welcome message so the
   * freelancer sees it when they accept the Connect invite.
   */
  actionUrl?: string
  /** Short label for the action ("Sign up for Frame.io", etc.) */
  actionLabel?: string
}
