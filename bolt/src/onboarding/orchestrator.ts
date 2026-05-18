// @ts-nocheck
/**
 * Freelancer Onboarding Orchestrator
 *
 * Runs the four service invites in parallel via Promise.allSettled,
 * tracks per-service status in public.freelancer_onboardings, then
 * composes and sends a welcome DM to the artist.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import type { OnboardingInput, OnboardingProject, ServiceResult } from './types'

import { inviteArtistToSlack, fetchWelcomeCanvas, sendWelcomeDm } from './services/slack'
import { inviteArtistToDropbox } from './services/dropbox'
import { inviteArtistToFrameIo } from './services/frameio'
import { inviteArtistToHarvest } from './services/harvest'

async function loadProject(projectId: string): Promise<OnboardingProject | null> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('projects')
    .select(
      'id, name, client, project_code, brief_summary, target_delivery, external_links, external_ids',
    )
    .eq('id', projectId)
    .maybeSingle()
  if (error) {
    console.warn(`[onboarding] loadProject failed: ${error.message}`)
    return null
  }
  return (data as OnboardingProject) || null
}

/**
 * Compose the welcome DM markdown. Canvas content first (folder structure,
 * where to work — editable in Slack), then auto-generated project summary.
 */
function composeWelcomeDm(opts: {
  project: OnboardingProject
  artistName: string
  canvasMarkdown: string | null
}): string {
  const { project, artistName, canvasMarkdown } = opts
  const firstName = artistName.trim().split(/\s+/)[0] || 'there'

  const summaryLines: string[] = [`*Project: ${project.name}*`]
  if (project.client) summaryLines.push(`*Client:* ${project.client}`)
  if (project.project_code) summaryLines.push(`*Code:* ${project.project_code}`)
  if (project.target_delivery)
    summaryLines.push(`*Target delivery:* ${project.target_delivery}`)
  if (project.brief_summary) {
    summaryLines.push('')
    summaryLines.push(`*Brief:* ${project.brief_summary}`)
  }
  const links: string[] = []
  const frameioUrl = project.external_links?.frameio_url
  const dropboxUrl = project.external_links?.dropbox_url
  if (frameioUrl) links.push(`• Frame.io: ${frameioUrl}`)
  if (dropboxUrl) links.push(`• Dropbox: ${dropboxUrl}`)
  if (links.length) {
    summaryLines.push('')
    summaryLines.push('*Links:*')
    summaryLines.push(...links)
  }

  const parts: string[] = [
    `:wave: Hey ${firstName}, welcome to Ranger & Fox.`,
    '',
  ]
  if (canvasMarkdown) {
    parts.push(canvasMarkdown.trim(), '')
  }
  parts.push('━━━━━━━━━━━━━━━━━━━━', '', ...summaryLines)
  parts.push('', "Reach out anytime — happy to have you on this one.")
  return parts.join('\n')
}

/**
 * Orchestrate one artist's onboarding. Returns the freelancer_onboardings row.
 */
export async function runOnboarding(opts: {
  app: App
  input: OnboardingInput
}): Promise<{
  onboardingId: string | null
  results: Record<string, ServiceResult>
}> {
  const { app, input } = opts
  const sb = createAdminClient()

  const project = await loadProject(input.projectId)
  if (!project) {
    return {
      onboardingId: null,
      results: {
        slack: { status: 'skipped', message: 'project not found' },
        dropbox: { status: 'skipped', message: 'project not found' },
        frameio: { status: 'skipped', message: 'project not found' },
        harvest: { status: 'skipped', message: 'project not found' },
        welcomeDm: { status: 'skipped', message: 'project not found' },
      },
    }
  }

  // Insert the tracking row up front so we can attribute later.
  const { data: created, error: createErr } = await sb
    .from('freelancer_onboardings')
    .insert({
      project_id: project.id,
      artist_email: input.artistEmail,
      artist_name: input.artistName,
      requested_by_slack_user_id: input.requestedBy,
      slack_status: 'pending',
      dropbox_status: 'pending',
      frameio_status: 'pending',
      harvest_status: 'pending',
      welcome_dm_status: 'pending',
    })
    .select('id')
    .single()
  const onboardingId = created?.id || null
  if (createErr) {
    console.warn(`[onboarding] tracking row insert failed: ${createErr.message}`)
  }

  // Run the 4 invites in parallel.
  const projectChannelId: string | null =
    project.external_links?.slack_channel_id || null

  const [slackR, dropboxR, frameioR, harvestR] = await Promise.all([
    inviteArtistToSlack({
      email: input.artistEmail,
      fullName: input.artistName,
      projectChannelId,
    }),
    inviteArtistToDropbox({ project, artistEmail: input.artistEmail }),
    inviteArtistToFrameIo({ project, artistEmail: input.artistEmail }),
    inviteArtistToHarvest({
      project,
      artistEmail: input.artistEmail,
      artistName: input.artistName,
    }),
  ])

  // Send welcome DM if Slack invite produced a user id.
  let welcomeR: ServiceResult = {
    status: 'skipped',
    message: 'no slack user id from invite step',
  }
  if (slackR.status === 'ok' && slackR.slackUserId) {
    const canvasMarkdown = await fetchWelcomeCanvas()
    welcomeR = await sendWelcomeDm({
      artistSlackUserId: slackR.slackUserId,
      text: composeWelcomeDm({
        project,
        artistName: input.artistName,
        canvasMarkdown,
      }),
    })
  }

  // Upsert artist into staff so future ad-hoc paths work (employment_type=freelancer).
  if (slackR.slackUserId) {
    await sb.from('staff').upsert(
      {
        slack_user_id: slackR.slackUserId,
        email: input.artistEmail,
        full_name: input.artistName,
        role: 'creative',
        employment_type: 'freelancer',
        harvest_user_id: (harvestR as any).harvestUserId || null,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'slack_user_id' },
    )
  }

  // Update tracking row with per-service results.
  if (onboardingId) {
    await sb
      .from('freelancer_onboardings')
      .update({
        artist_slack_user_id: slackR.slackUserId || null,
        slack_status: slackR.status,
        slack_error: slackR.status === 'failed' ? slackR.message : null,
        dropbox_status: dropboxR.status,
        dropbox_error: dropboxR.status === 'failed' ? dropboxR.message : null,
        frameio_status: frameioR.status,
        frameio_error: frameioR.status === 'failed' ? frameioR.message : null,
        harvest_status: harvestR.status,
        harvest_error: harvestR.status === 'failed' ? harvestR.message : null,
        welcome_dm_status: welcomeR.status,
        welcome_dm_error: welcomeR.status === 'failed' ? welcomeR.message : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', onboardingId)
  }

  return {
    onboardingId,
    results: {
      slack: slackR,
      dropbox: dropboxR,
      frameio: frameioR,
      harvest: harvestR,
      welcomeDm: welcomeR,
    },
  }
}

/**
 * Build a summary message for the requester after one onboarding run.
 */
export function buildRequesterSummary(opts: {
  artistName: string
  artistEmail: string
  projectName: string
  results: Record<string, ServiceResult>
}): string {
  const { artistName, artistEmail, projectName, results } = opts
  const icon = (s: string) =>
    s === 'ok' ? ':white_check_mark:' : s === 'skipped' ? ':white_circle:' : ':x:'
  const order: [string, string][] = [
    ['slack', 'Slack'],
    ['dropbox', 'Dropbox'],
    ['frameio', 'Frame.io'],
    ['harvest', 'Harvest'],
    ['welcomeDm', 'Welcome DM'],
  ]
  const lines = order.map(([key, label]) => {
    const r = results[key]
    return `${icon(r.status)} *${label}* — ${r.message}`
  })
  return [`*Onboarding: ${artistName}* (${artistEmail}) → *${projectName}*`, '', ...lines].join(
    '\n',
  )
}
