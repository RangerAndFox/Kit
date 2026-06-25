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
import { rehydrateProjectExternalLinks } from './rehydrate'
import { postNdaCardIfFirstTimer } from './nda/send'

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
 * where to work — editable in Slack), then auto-generated project summary,
 * then any "action needed" items surfaced by service results.
 */
function composeWelcomeDm(opts: {
  project: OnboardingProject
  artistName: string
  canvasMarkdown: string | null
  actions?: { label: string; url: string }[]
}): string {
  const { project, artistName, canvasMarkdown, actions } = opts
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
  // Links land under either the rehydrated *_url keys or the provisioner's
  // bare service keys, depending on which path created the project. Accept both.
  const frameioUrl = project.external_links?.frameio_url || project.external_links?.frameio
  const dropboxUrl = project.external_links?.dropbox_url || project.external_links?.dropbox
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

  // Surface any "you need to do this" items right next to the project info.
  if (actions && actions.length > 0) {
    parts.push('', '*One quick thing to wrap up access:*')
    for (const a of actions) {
      parts.push(`• ${a.label}: ${a.url}`)
    }
  }

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

  // Rehydrate any missing external_links keys via API lookups before
  // we try to invite the artist. Mutates project.external_links in place
  // and persists discoveries to Supabase.
  try {
    const rehydrated = await rehydrateProjectExternalLinks({ app, project })
    if (rehydrated.discovered.length > 0) {
      console.log(
        `[onboarding] rehydrated ${project.id}: discovered=${rehydrated.discovered.join(',')} missing=${rehydrated.missing.join(',') || 'none'}`,
      )
    }
  } catch (err: any) {
    console.warn(`[onboarding] rehydrate failed for ${project.id}: ${err.message}`)
  }

  // Insert the tracking row up front so we can attribute later.
  const { data: created, error: createErr } = await sb
    .from('freelancer_onboardings')
    .insert({
      project_id: project.id,
      artist_email: input.artistEmail,
      artist_name: input.artistName,
      artist_legal_name: input.artistLegalName || null,
      requested_by_slack_user_id: input.requestedBy,
      slack_status: 'pending',
      dropbox_status: 'pending',
      frameio_status: 'pending',
      harvest_status: 'pending',
      welcome_dm_status: 'pending',
      nda_status: 'pending',
    })
    .select('id')
    .single()
  const onboardingId = created?.id || null
  if (createErr) {
    console.warn(`[onboarding] tracking row insert failed: ${createErr.message}`)
  }

  // Run the 4 invites in parallel.
  // Kit's slack provisioner stores the project channel id as external_links.slack_id.
  const projectChannelId: string | null =
    project.external_links?.slack_id ||
    project.external_links?.slack_channel_id ||
    null

  const settled = await Promise.allSettled([
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
  // One service throwing must not abort the others (or the NDA + tracking
  // below). A rejected invite becomes a failed ServiceResult.
  const asResult = (s: PromiseSettledResult<ServiceResult>, name: string): ServiceResult =>
    s.status === 'fulfilled'
      ? s.value
      : { status: 'failed', message: `${name} crashed: ${s.reason?.message || String(s.reason)}` }
  const slackR = asResult(settled[0], 'slack')
  const dropboxR = asResult(settled[1], 'dropbox')
  const frameioR = asResult(settled[2], 'frameio')
  const harvestR = asResult(settled[3], 'harvest')

  // Send welcome message. Two paths:
  //  - Slack user known → open DM and post privately
  //  - Connect invite pending → post into the project channel so the
  //    freelancer sees it as channel history when they accept
  let welcomeR: ServiceResult = {
    status: 'skipped',
    message: 'Slack invite did not succeed; no welcome sent.',
  }
  const slackInvite: any = slackR
  if (slackR.status === 'ok') {
    const canvasMarkdown = await fetchWelcomeCanvas()
    // Collect any actionable follow-ups from per-service results
    // (currently: Frame.io self-signup link when the artist isn't yet
    // in the account).
    const actions: { label: string; url: string }[] = []
    for (const r of [slackR, dropboxR, frameioR, harvestR]) {
      if (r.actionUrl && r.actionLabel) {
        actions.push({ label: r.actionLabel, url: r.actionUrl })
      }
    }
    const welcomeText = composeWelcomeDm({
      project,
      artistName: input.artistName,
      canvasMarkdown,
      actions,
    })

    if (slackInvite.slackUserId) {
      // Path A: existing workspace member → private DM.
      welcomeR = await sendWelcomeDm({
        artistSlackUserId: slackInvite.slackUserId,
        text: welcomeText,
      })
    } else if (slackInvite.connectPending && projectChannelId) {
      // Path B: Connect invite pending → post into channel so they
      // see it when they accept and land in the channel.
      try {
        await app.client.chat.postMessage({
          channel: projectChannelId,
          text: `Welcome ${input.artistName} (joining as a freelancer)`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: welcomeText },
            },
          ],
        })
        welcomeR = {
          status: 'ok',
          message: `Welcome posted in <#${projectChannelId}>; visible to ${input.artistName} when they accept the Connect invite.`,
        }
      } catch (err: any) {
        welcomeR = { status: 'failed', message: err.message || String(err) }
      }
    }
  }

  // NDA / paperwork (gated behind FREELANCER_PAPERWORK_ENABLED). For a
  // first-timer we post a confirmation card to the requester (falling back to
  // the project channel); they pick the NDA type, confirm the details, and
  // send it from the modal. Returning freelancers (paperwork on file) skipped.
  const ndaCardChannel = input.requestedBy || projectChannelId || ''
  const ndaR: ServiceResult = await postNdaCardIfFirstTimer({
    app,
    channel: ndaCardChannel,
    artistEmail: input.artistEmail,
    artistName: input.artistName,
    artistLegalName: input.artistLegalName,
    onboardingId,
  })

  // Upsert artist into staff so future paths know who they are.
  // Connect-invited freelancers don't have a Slack user id yet — we'll
  // backfill on their first message via the staff sync script, or
  // event-driven if we add a connect-acceptance handler later.
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
        // 'ok' here means the card was posted; the actual send (and nda_sent_at)
        // is recorded later by the modal handler (sendNdaFromModal).
        nda_status: ndaR.status === 'ok' ? 'card_posted' : ndaR.status,
        nda_error: ndaR.status === 'failed' ? ndaR.message : null,
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
      nda: ndaR,
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
    ['nda', 'NDA'],
  ]
  const lines = order
    .filter(([key]) => results[key])
    .map(([key, label]) => {
      const r = results[key]
      return `${icon(r.status)} *${label}* — ${r.message}`
    })
  return [`*Onboarding: ${artistName}* (${artistEmail}) → *${projectName}*`, '', ...lines].join(
    '\n',
  )
}
