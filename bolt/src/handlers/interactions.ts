// @ts-nocheck
/**
 * Bolt Interaction Handlers
 *
 * Handles modal submissions, button clicks, and other interactive payloads.
 * The big one: project provisioning after the /kit newproject modal is submitted.
 *
 * Because this runs in a persistent process (not a 60s serverless function),
 * provisioning runs directly in-process with no time pressure. We dispatch
 * to agents in parallel via Promise.allSettled and stream progress updates
 * to the user in real time.
 */

import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import {
  dispatch,
  getAvailableAgents,
} from '../../../src/lib/inngest/agents/registry'
import type { ServiceKey } from '../../../src/lib/provisioner/types'
import { buildNewProjectModal } from '../../../src/lib/provisioner/modal'
import { buildStoryboardModal } from '../../../src/lib/storyboard/modal'
import { peekIntake, takeIntake, updateIntake } from '../../../src/lib/storyboard/stash'
import { extractScriptFromFile } from '../../../src/lib/storyboard/files'
import { handleCheckinConfirm, handleCheckinRedo } from '../checkins/confirm'
import { parseOnboardSubmission } from '../onboarding/modal'
import { runOnboarding, buildRequesterSummary } from '../onboarding/orchestrator'
import { registerDeliveryViewHandlers } from '../delivery/submit-handler'

export function registerInteractionHandlers(app: App) {
  // ─── Delivery: profile-selection + create-profile modals ──
  registerDeliveryViewHandlers(app)

  // ─── Daily hours check-in: Confirm / Redo ─────────────────
  app.action('checkin_confirm', async ({ ack, body, client }) => {
    await ack()
    const checkinId = (body as any).actions?.[0]?.value || ''
    if (!checkinId) return
    handleCheckinConfirm({ app, client, body, checkinId }).catch((err) =>
      console.error('[checkin] confirm failed:', err),
    )
  })

  app.action('checkin_redo', async ({ ack, body, client }) => {
    await ack()
    const checkinId = (body as any).actions?.[0]?.value || ''
    if (!checkinId) return
    handleCheckinRedo({ app, client, body, checkinId }).catch((err) =>
      console.error('[checkin] redo failed:', err),
    )
  })

  // ─── Freelancer Onboarding: modal submit ──────────────────
  app.view('kit_onboard_submit', async ({ ack, view, body, client }) => {
    const parsed = parseOnboardSubmission(view)
    if (!parsed) {
      await ack({
        response_action: 'errors',
        errors: { project: 'Pick a project and at least one artist (name + email).' },
      })
      return
    }
    await ack()

    const requestedBy = body.user?.id || ''
    const targetChannel = parsed.channelId || (body.user?.id ? body.user.id : '')

    // Run each artist's onboarding sequentially so we don't hammer any
    // single service with parallel writes; per-artist services still run
    // in parallel internally.
    for (const artist of parsed.artists) {
      try {
        const { results } = await runOnboarding({
          app,
          input: {
            projectId: parsed.projectId,
            artistEmail: artist.email,
            artistName: artist.name,
            artistLegalName: artist.legalName,
            requestedBy,
          },
        })

        // Pull project name for the summary.
        let projectName = parsed.projectId
        try {
          const proj = await (
            await import('../../../src/lib/supabase/admin')
          ).createAdminClient()
          const { data } = await proj
            .from('projects')
            .select('name')
            .eq('id', parsed.projectId)
            .maybeSingle()
          if (data?.name) projectName = data.name
        } catch {
          /* fallback to id */
        }

        const summary = buildRequesterSummary({
          artistName: artist.name,
          artistEmail: artist.email,
          projectName,
          results,
        })
        await client.chat.postEphemeral({
          channel: targetChannel || requestedBy,
          user: requestedBy,
          text: summary,
        })
      } catch (err: any) {
        console.error(`[onboarding] ${artist.email} failed:`, err)
        await client.chat.postEphemeral({
          channel: targetChannel || requestedBy,
          user: requestedBy,
          text: `:x: Onboarding *${artist.name}* (${artist.email}) crashed: ${err.message || String(err)}`,
        })
      }
    }
  })

  // ─── Onboarding: natural-language [Onboard] confirm button ─
  app.action('kit_onboard_confirm', async ({ ack, body, client, respond }) => {
    await ack()
    const raw = (body as any).actions?.[0]?.value || '{}'
    let payload: { p?: string; n?: string; e?: string }
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = {}
    }
    const projectId = payload.p
    const artistName = payload.n
    const artistEmail = payload.e
    const requestedBy = (body as any).user?.id || ''
    const channelId = (body as any).channel?.id || ''
    const threadTs = (body as any).message?.thread_ts

    if (!projectId || !artistName || !artistEmail) {
      await respond({
        response_type: 'ephemeral',
        replace_original: false,
        text: ":warning: Lost the onboarding details — try the message again.",
      })
      return
    }

    // Replace the card with a "running" state.
    try {
      await respond({
        replace_original: true,
        text: `:hourglass_flowing_sand: Onboarding *${artistName}* — running invites...`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:hourglass_flowing_sand: Onboarding *${artistName}* (${artistEmail}) — running invites...`,
            },
          },
        ],
      })
    } catch {
      /* non-fatal */
    }

    try {
      const { results } = await runOnboarding({
        app,
        input: { projectId, artistEmail, artistName, requestedBy },
      })
      // Pull project name for the summary
      let projectName = projectId
      try {
        const sb = createAdminClient()
        const { data } = await sb
          .from('projects')
          .select('name')
          .eq('id', projectId)
          .maybeSingle()
        if (data?.name) projectName = data.name
      } catch {
        /* fallback to id */
      }
      const summary = buildRequesterSummary({
        artistName,
        artistEmail,
        projectName,
        results,
      })
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: summary,
      })
    } catch (err: any) {
      console.error('[onboard-confirm] failed:', err)
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `:x: Onboarding *${artistName}* crashed: ${err.message || String(err)}`,
      })
    }
  })

  app.action('kit_onboard_cancel', async ({ ack, respond }) => {
    await ack()
    await respond({
      replace_original: true,
      text: 'Cancelled onboarding.',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: ':white_circle: Cancelled.' },
        },
      ],
    })
  })

  // ─── New Project: open modal from card button ─────────────
  // The card posted by /kit newproject and the chat-keyword trigger
  // carries the originating channel id in the button value, so we can
  // open the modal with a fresh trigger_id and route the summary back.
  app.action('kit_open_newproject_modal', async ({ ack, body, client }) => {
    await ack()
    const raw = (body as any).actions?.[0]?.value || ''
    let channelId = ''
    let threadTs: string | undefined
    try {
      const parsed = JSON.parse(raw)
      channelId = parsed.c || ''
      threadTs = parsed.t || undefined
    } catch {
      // Backwards compatibility: older cards stored just the channel id.
      channelId = raw || (body as any).channel?.id || ''
    }
    const availableServiceIds = getProvisionableServices() as string[]
    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildNewProjectModal(channelId, availableServiceIds, threadTs) as any,
      })
    } catch (err: any) {
      console.error('[Bolt] newproject modal open failed:', err.data?.error || err.message)
    }
  })

  app.action('kit_cancel_newproject', async ({ ack, respond }) => {
    await ack()
    if (typeof respond === 'function') {
      await respond({ replace_original: true, text: '_New project cancelled._' })
    }
  })

  // ─── Storyboard intake: open modal from card button ───────
  // The card posted on file-drop / keyword-trigger carries the stash
  // token as the button value. We re-open the modal here with a fresh
  // trigger_id (which message events don't have).
  app.action('kit_open_storyboard_modal', async ({ ack, body, client }) => {
    await ack()
    const stashToken = (body as any).actions?.[0]?.value || ''
    const intake = peekIntake(stashToken)
    if (!intake) {
      await client.chat.postMessage({
        channel: (body as any).user?.id,
        text: "That storyboard session expired — type `storyboard` again to start fresh.",
      })
      return
    }
    // Backfill thread context from the button click container — works for
    // /storyboard slash command that didn't capture thread context up front,
    // and also for any future entry points that drop the card without it.
    const containerThreadTs = (body as any).container?.thread_ts as string | undefined
    if (containerThreadTs && !intake.assistantThreadTs) {
      updateIntake(stashToken, { assistantThreadTs: containerThreadTs })
    }
    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildStoryboardModal({
          stashToken,
          suggestedName: intake.suggestedName,
          scriptAttached: !!(intake.file || intake.script),
        }) as any,
      })
    } catch (err: any) {
      console.error('[Bolt] storyboard modal open failed:', err.data?.error || err.message)
    }
  })

  app.action('kit_cancel_storyboard', async ({ ack, body, client, respond }) => {
    await ack()
    const stashToken = (body as any).actions?.[0]?.value || ''
    takeIntake(stashToken) // discard
    if (typeof respond === 'function') {
      await respond({ replace_original: true, text: '_Storyboard cancelled._' })
    }
  })

  // ─── Storyboard Settings Modal Submission ─────────────────
  app.view('kit_provision_storyboard', async ({ ack, view, body, client }) => {
    // Ack immediately so Slack dismisses the modal. The work happens
    // after — we DM the user with progress and the final summary.
    await ack()

    const meta = JSON.parse(view.private_metadata || '{}')
    const stashToken = meta.stashToken || ''
    const intake = takeIntake(stashToken)
    const userId = body.user.id
    const channelId = intake?.channelId || userId
    const threadTs = intake?.assistantThreadTs
    const postOpts = (extra: Record<string, unknown> = {}) => ({
      channel: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...extra,
    })
    const values = view.state?.values || {}

    const form = {
      projectName: (values.project_name?.val?.value || '').trim(),
      pastedScript: (values.script?.val?.value || '').trim(),
      videoStyle: values.video_style?.val?.selected_option?.value || undefined,
      aspectRatio: values.aspect_ratio?.val?.selected_option?.value || '16:9',
      secondsPerFrame: Number(
        values.seconds_per_frame?.val?.selected_option?.value || 5,
      ),
      mode: values.mode?.val?.selected_option?.value || 'auto',
    }

    // ── Resolve script source ───────────────────────────────
    // Priority: stashed file → stashed pasted script (from earlier) →
    // script typed into the modal → blank.
    let script = ''
    let scriptSource = 'none'
    try {
      if (intake?.file) {
        await client.chat.postMessage(postOpts({
          text: `📥 Downloading *${intake.file.name}*…`,
        }))
        script = await extractScriptFromFile(intake.file)
        scriptSource = 'file'
      } else if (intake?.script) {
        script = intake.script
        scriptSource = 'stashed-paste'
      } else if (form.pastedScript) {
        script = form.pastedScript
        scriptSource = 'modal-paste'
      }
    } catch (err: any) {
      console.error('[Bolt] storyboard file ingest failed:', err)
      await client.chat.postMessage(postOpts({
        text: `❌ Couldn't read the script file: ${err.message || 'unknown error'}`,
      }))
      return
    }

    const blank = !script
    if (blank) {
      await client.chat.postMessage(postOpts({
        text: `📝 Creating a blank storyboard *${form.projectName}*…`,
      }))
    } else {
      await client.chat.postMessage(postOpts({
        text:
          `⚙️ Parsing script (${scriptSource}, mode: ${form.mode}) and creating ` +
          `*${form.projectName}* in Boords…`,
      }))
    }

    // ── Dispatch to Boords agent ────────────────────────────
    try {
      const result = await dispatch('boords', 'provision', {
        projectName: form.projectName,
        script,
        blank,
        mode: form.mode,
        aspectRatio: form.aspectRatio,
        secondsPerFrame: form.secondsPerFrame,
        videoStyle: form.videoStyle,
        slackUserId: userId,
        channelId,
      })

      if (!result.success) {
        const hint = (result.data as any)?.hint
        await client.chat.postMessage(postOpts({
          text:
            `❌ Storyboard failed: ${result.error || 'unknown error'}` +
            (hint ? `\n${hint}` : ''),
        }))
        return
      }

      // ── Final summary card ────────────────────────────────
      const data = (result.data as any) || {}
      const frames = data.frameCount || 0
      const runtimeSec = data.runtimeSeconds || frames * form.secondsPerFrame
      const mins = Math.floor(runtimeSec / 60)
      const secs = runtimeSec % 60
      const runtime = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
      const url = result.url || data.url
      const preview = Array.isArray(data.preview) ? data.preview : []

      const blocks: any[] = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `:clapper: *${data.storyboardName || form.projectName}* is ready in Boords.\n` +
              `${frames} frame${frames === 1 ? '' : 's'} · ${runtime} · ` +
              `${form.aspectRatio}${data.detectedTable ? ' · A/V table detected' : ''}`,
          },
        },
      ]
      if (preview.length > 0) {
        const previewLines = preview
          .map(
            (p: any) =>
              `*${p.label}* — ${p.sound || '_(no VO)_'}` +
              (p.action ? `\n   _${p.action}_` : ''),
          )
          .join('\n\n')
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Preview*\n\n${previewLines}` +
              (frames > preview.length ? `\n\n…and ${frames - preview.length} more` : ''),
          },
        })
      }
      if (url) {
        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Open in Boords' },
              url,
              action_id: 'kit_open_storyboard_url',
            },
          ],
        })
      }

      await client.chat.postMessage(postOpts({
        text: result.message || `Storyboard created: ${url || data.storyboardName}`,
        blocks,
      }))
    } catch (err: any) {
      console.error('[Bolt] storyboard provision error:', err)
      await client.chat.postMessage(postOpts({
        text: `❌ Storyboard failed: ${err.message || String(err)}`,
      }))
    }
  })

  // The "Open in Boords" link button is link-only; ack so Slack doesn't
  // warn about an unhandled action.
  app.action('kit_open_storyboard_url', async ({ ack }) => {
    await ack()
  })

  // ─── Project Provisioning Modal ───────────────────────────
  app.view('kit_provision_project', async ({ ack, view, body, client }) => {
    // Ack immediately to dismiss the modal
    await ack()

    const userId = body.user.id
    const meta = JSON.parse(view.private_metadata || '{}')
    const channelId = meta.channel_id || ''
    const threadTs = meta.thread_ts || undefined
    // Progress and errors post into the same channel/thread the user
    // launched the flow from. Falls back to DMing the user when we
    // somehow don't have a channel (shouldn't happen via the card).
    const statusChannel = channelId || userId
    const values = view.state?.values || {}

    // Extract form values. Services are read from the checkbox group;
    // if for any reason the field is empty (older modal, etc.) we fall back
    // to provisioning everything available.
    const rawBudget = values.budget?.val?.value
    const parsedBudget = rawBudget ? parseFloat(String(rawBudget).replace(/[$,\s]/g, '')) : NaN
    const selectedFromForm = (values.services?.val?.selected_options || [])
      .map((o: any) => o.value as ServiceKey)
    const form = {
      projectNumber: values.project_number?.val?.value || '',
      projectName: values.project_name?.val?.value || '',
      clientName: values.client_name?.val?.value || '',
      projectType: values.project_type?.val?.selected_option?.value || 'Other',
      projectManager: values.project_manager?.val?.selected_user || userId,
      creativeDirector: values.creative_director?.val?.selected_user || undefined,
      teamMembers: values.team_members?.val?.selected_users || [],
      startDate: values.start_date?.val?.selected_date || undefined,
      deadline: values.deadline?.val?.selected_date || undefined,
      description: values.description?.val?.value || undefined,
      budgetTotal: Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : undefined,
      selectedServices:
        selectedFromForm.length > 0 ? selectedFromForm : getProvisionableServices(),
    }

    // Resolve workspace
    const teamId = body.team?.id || ''
    const workspaceId = await resolveWorkspaceId(teamId)

    // ── Duplicate guard ───────────────────────────────────
    // If a project with this number already exists in the workspace, don't
    // silently create a second channel + record. Ask the producer whether to
    // replace it, create a duplicate, or cancel.
    const existing = await findExistingProject(workspaceId, form.projectNumber)
    if (existing) {
      const token = putPendingProvision({ form, workspaceId, userId, statusChannel, threadTs, existing })
      await client.chat.postMessage(
        postProvisionDupPrompt(statusChannel, threadTs, existing, token),
      )
      return
    }

    await runProjectProvisioning({ client, form, workspaceId, userId, statusChannel, threadTs })
  })

  // ─── New Project: duplicate-resolution buttons ────────────
  app.action('kit_provision_dup_duplicate', async ({ ack, body, client, respond }) => {
    await ack()
    const pending = takePendingProvision((body as any).actions?.[0]?.value || '')
    if (!pending) {
      await respond({ replace_original: true, text: ':warning: That request expired — re-run the project form.' })
      return
    }
    await respond({
      replace_original: true,
      text: `:heavy_plus_sign: Creating a *duplicate* project for ${pending.form.projectName}...`,
    })
    await runProjectProvisioning({ client, ...pending })
  })

  app.action('kit_provision_dup_replace', async ({ ack, body, client, respond }) => {
    await ack()
    const pending = takePendingProvision((body as any).actions?.[0]?.value || '')
    if (!pending) {
      await respond({ replace_original: true, text: ':warning: That request expired — re-run the project form.' })
      return
    }
    await respond({
      replace_original: true,
      text: `:wastebasket: Removing the old *${pending.existing.name}* and creating a fresh one...`,
    })
    try {
      await archiveOldProject(client, pending.existing)
    } catch (err: any) {
      console.error('[provision-dup] archive old project failed (continuing):', err?.message)
    }
    await runProjectProvisioning({ client, ...pending })
  })

  app.action('kit_provision_dup_cancel', async ({ ack, body, respond }) => {
    await ack()
    takePendingProvision((body as any).actions?.[0]?.value || '')
    await respond({ replace_original: true, text: ':white_circle: Cancelled — nothing was created.' })
  })

  // Provision a project across all selected services. Extracted so both the
  // modal submit (no duplicate) and the duplicate-resolution buttons run the
  // exact same path.
  async function runProjectProvisioning(args: {
    client: any
    form: any
    workspaceId: string
    userId: string
    statusChannel: string
    threadTs?: string
  }) {
    const { client, form, workspaceId, userId, statusChannel, threadTs } = args
    const postOpts = (extra: Record<string, unknown> = {}) => ({
      channel: statusChannel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...extra,
    })

    // ── Run provisioning in-process (no timeout!) ───────────
    // This is the whole point of moving to Bolt on Railway.
    // No after(), no Inngest, no 60s ceiling. Just do the work.

    try {
      // Tell the user we're starting (in the same thread the flow started in)
      await client.chat.postMessage(postOpts({
        text: `⚡ Provisioning *${form.projectName}* for ${form.clientName}...`,
      }))

      // Build the project code
      const projectCode = `${form.projectNumber}-${form.clientName.replace(/\s+/g, '')}`

      // Same shape the Dropbox provisioner uses (`/production/{year}/{safeName}`).
      // Persisted so the file watcher can reverse-match Dropbox paths to projects.
      const dropboxSafeName = [form.projectNumber, form.clientName, form.projectName]
        .map((p) => (p ? String(p).trim() : ''))
        .filter(Boolean)
        .join('_')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '_')

      // ── Create project record in Supabase ─────────────────
      const supabase = createAdminClient()
      const { data: project, error: dbError } = await supabase
        .from('projects')
        .insert({
          workspace_id: workspaceId,
          name: form.projectName,
          client: form.clientName,
          project_code: projectCode,
          project_type: form.projectType,
          status: 'provisioning',
          start_date: form.startDate || null,
          target_delivery: form.deadline || null,
          brief_summary: form.description || null,
          budget_total: form.budgetTotal ?? null,
          project_manager_slack_id: form.projectManager || null,
          external_ids: {
            dropbox_safe_name: dropboxSafeName,
            ...(form.creativeDirector ? { creative_director_slack_id: form.creativeDirector } : {}),
          },
        })
        .select()
        .single()

      if (dbError || !project) {
        throw new Error(`Failed to create project record: ${dbError?.message || 'unknown'}`)
      }

      // ── Fan-out to agents in parallel ─────────────────────
      const services = form.selectedServices
      const provisionPayload = {
        projectId: project.id,
        projectName: form.projectName,
        // Send both `client` and `clientName` — different agents read different keys.
        client: form.clientName,
        clientName: form.clientName,
        projectNumber: form.projectNumber,
        projectCode,
        projectType: form.projectType,
        workspaceId,
        // Identity + invitees so Slack channel auto-invites the requester + PM + team.
        slackUserId: userId,
        projectManager: form.projectManager,
        creativeDirector: form.creativeDirector,
        teamMembers: form.teamMembers,
        startDate: form.startDate,
        deadline: form.deadline,
        targetDelivery: form.deadline,
        briefSummary: form.description,
        // Harvest only accepts budget at creation time; carry it through so
        // the Harvest agent can attach budget_by='project' + budget=<amount>.
        budgetTotal: form.budgetTotal,
      }

      console.log(`[Bolt] Provisioning ${form.projectName} across ${services.length} services`)

      // Run one service's provision + post its progress line. Returns a
      // { service, ...result } shape (never throws).
      const runService = async (service: string, payload: Record<string, unknown>) => {
        try {
          const result = await dispatch(service, 'provision', payload)
          const status = result.success ? '✅' : '⚠️'
          await client.chat.postMessage(postOpts({
            text: `${status} *${service}*: ${result.message || (result.success ? 'Done' : result.error || 'Failed')}`,
          }))
          return { service, ...result }
        } catch (err: any) {
          await client.chat.postMessage(postOpts({ text: `❌ *${service}*: ${err.message}` }))
          return { service, agent: service, action: 'provision', success: false, error: err.message }
        }
      }

      const serviceResults: Record<string, any> = {}

      // Two-phase so the Slack canvas can be seeded with the Dropbox +
      // Frame.io links Kit just created. Phase 1: everything that produces
      // a link, in parallel. Phase 2: Slack (channel + canvas), with those
      // links passed through to the canvas fill. If Slack isn't selected,
      // phase 1 covers everything.
      const slackSelected = services.includes('slack' as ServiceKey)
      const phase1Services = services.filter((s) => s !== 'slack')

      const phase1 = await Promise.allSettled(
        phase1Services.map((service) => runService(service as string, provisionPayload)),
      )
      for (const settled of phase1) {
        const result = settled.status === 'fulfilled'
          ? settled.value
          : { service: 'unknown', success: false, error: settled.reason?.message }
        serviceResults[result.service] = result
      }

      if (slackSelected) {
        // Pass the freshly-created Dropbox + Frame.io URLs so the canvas's
        // "Assets Folders" rows get filled in. These are canvas-only fields
        // (kept separate from collectedLinks so we don't re-introduce the
        // in-channel links message).
        const slackResult = await runService('slack', {
          ...provisionPayload,
          dropboxUrl: serviceResults.dropbox?.url,
          frameioUrl: serviceResults.frameio?.url,
        })
        serviceResults[slackResult.service] = slackResult
      }

      // ── Update project status ─────────────────────────────
      const allSucceeded = Object.values(serviceResults).every((r: any) => r.success)
      const projectLinks: Record<string, string> = {}
      for (const [svc, result] of Object.entries(serviceResults)) {
        if ((result as any).url) projectLinks[svc] = (result as any).url
        if ((result as any).id) projectLinks[`${svc}_id`] = (result as any).id
      }

      await supabase
        .from('projects')
        .update({
          status: allSucceeded ? 'active' : 'partial',
          external_links: projectLinks,
        })
        .eq('id', project.id)

      // (No provisioning-summary card is posted to the project channel —
      // the per-service breakdown was noisy + sometimes listed stale
      // services. The requester still gets the final ✅ summary as a DM /
      // status message below.)

      // ── Auto-seed the project brain ───────────────────────
      // New brains default to visibility='producers_only' so we DON'T
      // create a channel canvas (the channel may contain artists, and
      // briefs/budgets/contacts in the brain are producer-tier material
      // until the producer explicitly promotes the brain via
      // /kit brain visibility team. Best-effort: we never fail
      // provisioning over a brain seed.
      const brainSlackChannel = serviceResults.slack?.id
      if (brainSlackChannel && workspaceId) {
        try {
          const { seedBrainForChannel } = await import('../../../src/lib/brain/seed')
          const { createOrUpdateBrainCanvas } = await import('../../../src/lib/brain/canvas')
          const { setCanvasHandle } = await import('../../../src/lib/brain/store')

          const { loaded, created } = await seedBrainForChannel({
            workspaceId,
            slackChannelId: brainSlackChannel,
            author: userId || 'system',
          })

          if (loaded.row.visibility === 'team') {
            const handle = await createOrUpdateBrainCanvas({
              app: { client } as any,
              channelId: brainSlackChannel,
              brain: loaded.brain,
              existingCanvasId: loaded.row.canvas_id,
            })
            if (handle.canvas_id !== loaded.row.canvas_id || handle.canvas_url !== loaded.row.canvas_url) {
              await setCanvasHandle(loaded.row.id, handle.canvas_id, handle.canvas_url)
            }
            await client.chat.postMessage({
              channel: brainSlackChannel,
              text: created
                ? `:brain: I seeded this channel's brain with what I know so far — open the Canvas tab. Every fact I learn here goes in automatically. \`/kit brain why <claim>\` shows sources.`
                : `:brain: Brain refreshed (revision ${loaded.row.revision}).`,
            })
          } else {
            // producers_only — no channel canvas. DM the project creator
            // (who is presumably the producer) with a quick how-to so
            // they know the brain exists. Nothing posts in the channel.
            try {
              const dm: any = await client.conversations.open({ users: userId })
              const dmChannel = dm?.channel?.id
              if (dmChannel) {
                await client.chat.postMessage({
                  channel: dmChannel,
                  text:
                    `:brain: I seeded the project brain for <#${brainSlackChannel}> with what I know so far. ` +
                    `It's *producers-only* by default — no canvas in the channel, so artists don't see it.\n\n` +
                    `• \`/kit brain\` (from the project channel) — read the current brain (ephemeral to you)\n` +
                    `• \`/kit brain why <claim>\` — show the source behind a fact\n` +
                    `• \`/kit brain visibility team\` — flip to channel-visible Canvas if you want the team to see it`,
                })
              }
            } catch (err: any) {
              console.error('[Bolt] brain auto-seed DM failed:', err?.data?.error || err?.message)
            }
          }
        } catch (err: any) {
          console.error('[Bolt] brain auto-seed failed:', err.data?.error || err.message || err)
          // Non-fatal — provisioning already succeeded.
        }
      }

      // ── Final summary ─────────────────────────────────────
      const succeeded = Object.values(serviceResults).filter((r: any) => r.success).length
      const failed = services.length - succeeded
      await client.chat.postMessage(postOpts({
        text: failed === 0
          ? `✅ *${form.projectName}* is fully provisioned! (${succeeded}/${services.length} services)`
          : `⚠️ *${form.projectName}* provisioned with ${failed} issue(s). Check the project channel for details.`,
      }))

    } catch (err: any) {
      console.error('[Bolt] Provisioning failed:', err)
      await client.chat.postMessage(postOpts({
        text: `❌ Provisioning *${form.projectName}* failed: ${err.message || 'unknown error'}`,
      }))
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Every registered agent (with required env vars present) that declares a
 * `provision` capability. Single source of truth — adding a new agent with
 * provision support automatically extends the new-project flow.
 *
 * Boords is excluded: it provisions a storyboard, not a project, and has
 * its own dedicated flow (/storyboard).
 */
const NEW_PROJECT_EXCLUDED_SERVICES = new Set(['boords'])

function getProvisionableServices(): ServiceKey[] {
  return getAvailableAgents()
    .filter((agent) => agent.capabilities.some((c) => c.action === 'provision'))
    .map((agent) => agent.id as ServiceKey)
    .filter((id) => !NEW_PROJECT_EXCLUDED_SERVICES.has(id as string))
}

async function resolveWorkspaceId(teamId: string): Promise<string> {
  if (!teamId) return ''
  try {
    const supabase = createAdminClient()
    const { data } = await supabase
      .from('workspaces')
      .select('id')
      .eq('slack_team_id', teamId)
      .limit(1)
      .single()
    if (data?.id) return data.id

    const { data: first } = await supabase
      .from('workspaces')
      .select('id')
      .limit(1)
      .single()
    return first?.id || ''
  } catch {
    return ''
  }
}

// ─── New-project duplicate guard ────────────────────────────

interface PendingProvision {
  form: any
  workspaceId: string
  userId: string
  statusChannel: string
  threadTs?: string
  existing: { id: string; name: string; code?: string; slackId?: string }
}

// In-memory stash for a project provision awaiting a duplicate-resolution
// click. The Bolt app is a single Railway process, so a Map is fine; entries
// TTL out after an hour and a process restart just drops them (the producer
// re-runs the form).
const pendingProvisions = new Map<string, { value: PendingProvision; expires: number }>()
const PENDING_PROVISION_TTL_MS = 60 * 60 * 1000

function putPendingProvision(value: PendingProvision): string {
  const now = Date.now()
  for (const [k, v] of pendingProvisions) if (v.expires < now) pendingProvisions.delete(k)
  const token = `pp_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  pendingProvisions.set(token, { value, expires: now + PENDING_PROVISION_TTL_MS })
  return token
}

function takePendingProvision(token: string): PendingProvision | null {
  const entry = token ? pendingProvisions.get(token) : undefined
  if (!entry) return null
  pendingProvisions.delete(token)
  return entry.expires < Date.now() ? null : entry.value
}

/**
 * Find a non-archived project in the workspace that matches this request by
 * project number (the studio's unique key, encoded as the `{number}-{client}`
 * project_code). Null when there's no clash.
 */
async function findExistingProject(
  workspaceId: string,
  projectNumber: string,
): Promise<{ id: string; name: string; code?: string; slackId?: string } | null> {
  if (!workspaceId || !projectNumber) return null
  try {
    const sb = createAdminClient()
    const { data } = await sb
      .from('projects')
      .select('id, name, project_code, external_links, status')
      .eq('workspace_id', workspaceId)
      .ilike('project_code', `${projectNumber}-%`)
      .not('status', 'in', '("archived","cancelled")')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!data) return null
    return {
      id: data.id,
      name: data.name,
      code: data.project_code || undefined,
      slackId: (data as any).external_links?.slack_id || undefined,
    }
  } catch (err: any) {
    console.warn('[provision-dup] findExistingProject failed:', err?.message)
    return null
  }
}

function postProvisionDupPrompt(
  channel: string,
  threadTs: string | undefined,
  existing: { id: string; name: string; code?: string },
  token: string,
) {
  const label = existing.code ? `${existing.name} (${existing.code})` : existing.name
  return {
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: `:warning: A project already exists for this number: ${label}. What do you want to do?`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: A project already exists for this number: *${label}*.\nWhat do you want to do?`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'danger',
            text: { type: 'plain_text', text: 'Delete old + create new' },
            action_id: 'kit_provision_dup_replace',
            value: token,
            confirm: {
              title: { type: 'plain_text', text: 'Delete the old project?' },
              text: {
                type: 'mrkdwn',
                text: `This archives the old Slack channel and removes Kit's record for *${label}*. Dropbox and Frame.io folders are left untouched.`,
              },
              confirm: { type: 'plain_text', text: 'Delete old + create new' },
              deny: { type: 'plain_text', text: 'Back' },
            },
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Create duplicate' },
            action_id: 'kit_provision_dup_duplicate',
            value: token,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Cancel' },
            action_id: 'kit_provision_dup_cancel',
            value: token,
          },
        ],
      },
    ],
  }
}

/**
 * "Delete old" = free up the channel name (rename), archive the old Slack
 * channel, and remove Kit's project record (cascades to project_settings etc.).
 * External Dropbox / Frame.io folders are intentionally left intact — they
 * can't be safely auto-deleted.
 */
async function archiveOldProject(
  client: any,
  existing: { id: string; name: string; slackId?: string },
): Promise<void> {
  if (existing.slackId) {
    // Rename first so the replacement can reclaim the original slug (Slack
    // keeps an archived channel's name reserved otherwise).
    await client.conversations
      .rename({ channel: existing.slackId, name: `z-archived-${existing.slackId.toLowerCase()}`.slice(0, 80) })
      .catch(() => {})
    await client.conversations.archive({ channel: existing.slackId }).catch((err: any) => {
      console.warn('[provision-dup] channel archive failed (non-fatal):', err?.data?.error || err?.message)
    })
  }
  const sb = createAdminClient()
  await sb.from('projects').delete().eq('id', existing.id)
}
