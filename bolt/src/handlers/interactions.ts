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

import { randomUUID } from 'node:crypto'
import type { App } from '@slack/bolt'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import {
  dispatch,
  getAvailableAgents,
} from '../../../src/lib/inngest/agents/registry'
import type { ServiceKey } from '../../../src/lib/provisioner/types'
import { buildNewProjectModal } from '../../../src/lib/provisioner/modal'
import {
  getOrCreateCreationRequest,
  loadCreationRequest,
  updateCreationRequest,
  claimCreationRequest,
  commitCreationDecision,
  claimCreationRequestFenced,
  renewCreationRequestLease,
  listRecoverableRequests,
  listProjectsWithIncompleteSteps,
  loadCreationRequestByProjectId,
  listIncompleteBindings,
  getBindingByProject,
  getProvisioningSteps,
  claimProvisioningStep,
  recordStepExternalId,
  completeProvisioningStep,
} from '../../../src/lib/project-control/store'
import { bindProjectControl } from '../../../src/lib/project-control/creation'
import { runDurableProvisioning } from '../../../src/lib/project-control/provisioning-steps'
import { runProjectControlRecovery } from '../../../src/lib/project-control/recovery'
import {
  resolveCreationProject,
  runDisabledCreation,
  routeCreationRequest,
  authorizeResolution,
  shouldArchiveReplaceTarget,
  resolveReplaceCleanup,
} from '../../../src/lib/project-control/creation-request'
import {
  projectControlCreationEnabled,
  workbookConfigFromEnv,
} from '../../../src/lib/project-control/types'
import { resolveControlTemplate } from '../../../src/lib/project-control/canvas'
import { buildStoryboardModal } from '../../../src/lib/storyboard/modal'
import { peekIntake, takeIntake, updateIntake } from '../../../src/lib/storyboard/stash'
import { extractScriptFromFile } from '../../../src/lib/storyboard/files'
import { handleCheckinConfirm, handleCheckinRedo } from '../checkins/confirm'
import { parseOnboardSubmission } from '../onboarding/modal'
import { runOnboarding, buildRequesterSummary } from '../onboarding/orchestrator'
import { registerDeliveryViewHandlers } from '../delivery/submit-handler'
import {
  NDA_REVIEW_ACTION,
  NDA_SEND_CALLBACK,
  buildNdaModalView,
  parseNdaContext,
  parseNdaModalSubmission,
} from '../onboarding/nda/card'
import { sendNdaFromModal } from '../onboarding/nda/send'

export function registerInteractionHandlers(app: App) {
  // ─── Delivery: profile-selection + create-profile modals ──
  registerDeliveryViewHandlers(app)

  // ─── NDA: "Review & send NDA" card button → modal ─────────
  app.action(NDA_REVIEW_ACTION, async ({ ack, body, client }) => {
    await ack()
    const ctx = parseNdaContext((body as any).actions?.[0]?.value || '')
    if (!ctx) {
      await client.chat.postMessage({
        channel: (body as any).user?.id,
        text: 'That NDA card expired — re-run onboarding for this artist to get a fresh one.',
      })
      return
    }
    try {
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: buildNdaModalView(ctx) as any,
      })
    } catch (err: any) {
      console.error('[Bolt] NDA modal open failed:', err.data?.error || err.message)
    }
  })

  // ─── NDA: modal submit → fill, convert (Company), email ────
  app.view(NDA_SEND_CALLBACK, async ({ ack, view, body, client }) => {
    const ctx = parseNdaContext((view as any).private_metadata || '')
    const { ndaType, company, date } = parseNdaModalSubmission(view)
    if (!ctx) {
      await ack()
      return
    }
    if (ndaType === 'company' && !company) {
      await ack({
        response_action: 'errors',
        errors: { nda_company: 'Company NDA needs a legal entity name.' },
      })
      return
    }
    await ack()

    const notify = (text: string) =>
      client.chat
        .postMessage({ channel: ctx.channel || (body as any).user?.id, text })
        .catch((e) => console.error('[Bolt] NDA notify failed:', e?.message))

    // Do the work off the ack path — fill + Drive conversion + email can take
    // a few seconds, well past Slack's 3s ack window.
    sendNdaFromModal({ ndaType, company, date, ctx })
      .then((res) =>
        notify(
          res.status === 'ok'
            ? `:white_check_mark: ${res.message}`
            : `:warning: NDA not sent — ${res.message}`,
        ),
      )
      .catch((err) => notify(`:warning: NDA send failed — ${err.message || err}`))
  })

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
  // In-process double-click guard: replace_original isn't instantaneous, so
  // two quick clicks (or a Slack action retry) would run the full onboarding
  // twice — duplicate service invites, duplicate paperwork rows, two NDAs.
  const onboardInFlight = new Set<string>()
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

    const inflightKey = `${projectId}:${artistEmail.toLowerCase()}`
    if (onboardInFlight.has(inflightKey)) return
    onboardInFlight.add(inflightKey)

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
    } finally {
      onboardInFlight.delete(inflightKey)
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

    // Stash lost (process restart between card and submit, or the 30-min TTL
    // lapsed) while the user attached a FILE via the intake card: without the
    // stash there is no file reference, and proceeding used to silently
    // create a BLANK storyboard. Detect it via the token: a token was issued
    // but no intake came back, and the modal has no pasted script to fall
    // back on.
    const modalScript = (view.state?.values?.script?.val?.value || '').trim()
    if (stashToken && !intake && !modalScript) {
      await client.chat.postMessage({
        channel: userId,
        text:
          "⚠️ I lost track of the script you attached (it expires after 30 minutes, and a redeploy clears it). " +
          'Re-upload the file or paste the script into the storyboard form and try again.',
      })
      return
    }
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

    // Project Control is gated OFF by default. When disabled we take the
    // ORIGINAL pre-mission path: no migration-056 table is touched, the
    // in-memory pending map backs the duplicate prompt, and provisioning is
    // unchanged. When enabled we use the durable creation-request ledger.
    const creationEnabled = projectControlCreationEnabled()

    if (!creationEnabled) {
      const existing = await findExistingProject(workspaceId, form.projectNumber)
      if (existing) {
        const token = putPendingProvision({ form, workspaceId, userId, statusChannel, threadTs, existing })
        await client.chat.postMessage(postProvisionDupPrompt(statusChannel, threadTs, existing, token))
        return
      }
      await runProjectProvisioning({ client, form, workspaceId, userId, statusChannel, threadTs, creationEnabled: false })
      return
    }

    // ── Persisted idempotency ledger (keyed by Slack view.id) ──
    // A Socket-Mode redelivery resumes the SAME request instead of creating a
    // second project; an intentional duplicate is a new modal → new view.id.
    // routeCreationRequest is the deterministic state machine that decides what
    // to do, checking THIS request's ownership before the number dup guard so a
    // crashed request's own project resumes rather than prompting the producer.
    const requestKey = view.id
    const { row: reqRow } = await getOrCreateCreationRequest({
      requestKey,
      workspaceId,
      requestedBy: userId,
      submission: { form, userId, statusChannel, threadTs, workspaceId },
    })

    const leaseActive =
      !!reqRow.lease_expires_at && new Date(reqRow.lease_expires_at).getTime() > Date.now()
    const linkedProjectId = reqRow.project_id || (await findProjectIdByRequestKey(requestKey))
    const existing = await findExistingProject(workspaceId, form.projectNumber, true)
    const unrelatedExisting =
      existing && existing.creationRequestId !== requestKey && existing.id !== linkedProjectId
        ? { id: existing.id, name: existing.name }
        : null

    const decision = routeCreationRequest({ status: reqRow.status, linkedProjectId, leaseActive, unrelatedExisting })
    switch (decision.action) {
      case 'already_completed':
        await client.chat.postMessage({
          channel: statusChannel,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: `:information_source: *${form.projectName}* was already created for this request — not creating it again.`,
        })
        return
      case 'awaiting_decision':
      case 'in_flight':
        return // leave the open prompt / let the active worker finish
      case 'duplicate_prompt':
        // Persist the EXACT conflict project id when the prompt is first created,
        // so the target cannot change between prompt and click.
        await updateCreationRequest(requestKey, {
          status: 'awaiting_decision',
          replace_target_project_id: existing!.id,
        })
        await client.chat.postMessage(postProvisionDupPrompt(statusChannel, threadTs, existing!, requestKey))
        return
      case 'resume':
        await runProjectProvisioning({ client, form, workspaceId, userId, statusChannel, threadTs, requestKey, creationEnabled: true })
        return
      case 'provision':
        await updateCreationRequest(requestKey, { decision: 'create' })
        await runProjectProvisioning({ client, form, workspaceId, userId, statusChannel, threadTs, requestKey, creationEnabled: true })
        return
    }
  })

  // ─── New Project: duplicate-resolution buttons ────────────
  app.action('kit_provision_dup_duplicate', async ({ ack, body, client, respond }) => {
    await ack()
    const value = (body as any).actions?.[0]?.value || ''
    if (!projectControlCreationEnabled()) {
      const pending = takePendingProvision(value)
      if (!pending) {
        await respond({ replace_original: true, text: ':warning: That request expired — re-run the project form.' })
        return
      }
      await respond({ replace_original: true, text: `:heavy_plus_sign: Creating a *duplicate* project for ${pending.form.projectName}...` })
      await runProjectProvisioning({ client, ...pending, creationEnabled: false })
      return
    }
    const req = await loadCreationRequest(value)
    const actingWorkspaceId = await resolveWorkspaceId((body as any).team?.id || '')
    const auth = authorizeResolution(req, { actingUserId: (body as any).user?.id || '', workspaceId: actingWorkspaceId, action: 'duplicate' })
    if (!auth.ok) {
      await respond({ replace_original: true, text: authRefusalText(auth.reason) })
      return
    }
    const { form, userId, statusChannel, threadTs, workspaceId } = req!.submission
    // Atomic CAS: only the FIRST competing click transitions the request out of
    // awaiting_decision. A racing replace/cancel (or a double duplicate) loses.
    const won = await commitCreationDecision({
      requestKey: value, actingUserId: (body as any).user?.id || '', workspaceId: actingWorkspaceId, decision: 'duplicate',
    })
    if (!won) {
      await respond({ replace_original: true, text: ':information_source: That request was already resolved.' })
      return
    }
    await respond({ replace_original: true, text: `:heavy_plus_sign: Creating a *duplicate* project for ${form.projectName}...` })
    await runProjectProvisioning({ client, form, workspaceId, userId, statusChannel, threadTs, requestKey: value, creationEnabled: true })
  })

  app.action('kit_provision_dup_replace', async ({ ack, body, client, respond }) => {
    await ack()
    const value = (body as any).actions?.[0]?.value || ''
    if (!projectControlCreationEnabled()) {
      const pending = takePendingProvision(value)
      if (!pending) {
        await respond({ replace_original: true, text: ':warning: That request expired — re-run the project form.' })
        return
      }
      await respond({ replace_original: true, text: `:wastebasket: Removing the old *${pending.existing.name}* and creating a fresh one...` })
      try {
        await archiveOldProject(client, pending.existing)
      } catch (err: any) {
        console.error('[provision-dup] archive old project failed (continuing):', err?.message)
      }
      await runProjectProvisioning({ client, ...pending, creationEnabled: false })
      return
    }
    const req = await loadCreationRequest(value)
    const actingWorkspaceId = await resolveWorkspaceId((body as any).team?.id || '')
    const auth = authorizeResolution(req, { actingUserId: (body as any).user?.id || '', workspaceId: actingWorkspaceId, action: 'replace' })
    if (!auth.ok) {
      await respond({ replace_original: true, text: authRefusalText(auth.reason) })
      return
    }
    const { form, userId, statusChannel, threadTs, workspaceId } = req!.submission
    // Atomic CAS: only the FIRST competing click wins. The conflict target was
    // persisted (replace_target_project_id) when the prompt was created, so it
    // cannot change between prompt and click. The archive itself is a durable
    // step inside runProjectProvisioning (keyed on the persisted target), so a
    // crash is recoverable and a replay can never archive the replacement.
    const won = await commitCreationDecision({
      requestKey: value, actingUserId: (body as any).user?.id || '', workspaceId: actingWorkspaceId, decision: 'replace',
    })
    if (!won) {
      await respond({ replace_original: true, text: ':information_source: That request was already resolved.' })
      return
    }
    await respond({ replace_original: true, text: `:wastebasket: Removing the old project and creating a fresh one...` })
    await runProjectProvisioning({ client, form, workspaceId, userId, statusChannel, threadTs, requestKey: value, creationEnabled: true })
  })

  app.action('kit_provision_dup_cancel', async ({ ack, body, respond }) => {
    await ack()
    const value = (body as any).actions?.[0]?.value || ''
    if (!projectControlCreationEnabled()) {
      takePendingProvision(value)
      await respond({ replace_original: true, text: ':white_circle: Cancelled — nothing was created.' })
      return
    }
    const req = await loadCreationRequest(value)
    const actingWorkspaceId = await resolveWorkspaceId((body as any).team?.id || '')
    const auth = authorizeResolution(req, { actingUserId: (body as any).user?.id || '', workspaceId: actingWorkspaceId, action: 'cancel' })
    if (!auth.ok) {
      await respond({ replace_original: true, text: authRefusalText(auth.reason) })
      return
    }
    // Atomic CAS to terminal 'cancelled' (never resumed). Loses to a racing
    // duplicate/replace that already committed.
    const won = await commitCreationDecision({
      requestKey: value, actingUserId: (body as any).user?.id || '', workspaceId: actingWorkspaceId, decision: 'cancel',
    })
    await respond({
      replace_original: true,
      text: won
        ? ':white_circle: Cancelled — nothing was created.'
        : ':information_source: That request was already resolved.',
    })
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
    requestKey?: string
    creationEnabled?: boolean
    // Set by the recovery sweep: it already holds this request's lease, so the
    // resume skips the redelivery-guard claim and heartbeats with THIS holder.
    preClaimed?: boolean
    leaseHolder?: string
  }) {
    const { client, form, workspaceId, userId, statusChannel, threadTs, requestKey } = args
    const creationEnabled = args.creationEnabled ?? projectControlCreationEnabled()
    // The lease holder for the durable heartbeat + the resume-safe claim. The
    // recovery sweep passes the holder it reclaimed with; the fresh path derives
    // it from the requester.
    const leaseHolder = args.leaseHolder ?? `bolt:${userId}`
    const preClaimed = args.preClaimed ?? false
    const postOpts = (extra: Record<string, unknown> = {}) => ({
      channel: statusChannel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...extra,
    })

    // ── Run provisioning in-process (no timeout!) ───────────
    // This is the whole point of moving to Bolt on Railway.
    // No after(), no Inngest, no 60s ceiling. Just do the work.

    try {
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

      // ── Create project record (idempotent, resume-safe) ────
      // When creation is ENABLED, resolveCreationProject owns the exclusive
      // lease + resume-safe insert (a redelivered submission / concurrent click
      // cannot create a second project; a crash between insert and ledger-link
      // is reconciled via projects.creation_request_id). When DISABLED it inserts
      // directly and touches no migration-056 table.
      const supabase = createAdminClient()
      const insertProject = async () => {
        const { data: inserted, error: dbError } = await supabase
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
            // Durable request→project identity (unique for non-null). Only
            // INCLUDED when creation is enabled, so the disabled path never
            // references the migration-056 column (pre-mission insert shape).
            ...(creationEnabled && requestKey ? { creation_request_id: requestKey } : {}),
            external_ids: {
              dropbox_safe_name: dropboxSafeName,
              ...(form.creativeDirector ? { creative_director_slack_id: form.creativeDirector } : {}),
            },
          })
          .select()
          .single()
        if (dbError || !inserted) {
          throw new Error(`Failed to create project record: ${dbError?.message || 'unknown'}`)
        }
        return { id: inserted.id }
      }
      const findProjectByRequestId = async (rk: string) => {
        if (!rk) return null
        const { data } = await supabase.from('projects').select('id').eq('creation_request_id', rk).maybeSingle()
        return data ? { id: data.id } : null
      }
      const announce = async () => {
        await client.chat.postMessage(postOpts({
          text: `⚡ Provisioning *${form.projectName}* for ${form.clientName}...`,
        }))
      }

      let projectId: string
      if (!creationEnabled) {
        // Pre-mission order: announce "Provisioning…" FIRST, then insert. No
        // migration-056 store is consulted on this path.
        const created = await runDisabledCreation({ announce, insertProject })
        projectId = created.id
      } else {
        const ensured = await resolveCreationProject(
          {
            store: { getOrCreateCreationRequest, loadCreationRequest, updateCreationRequest, claimCreationRequest },
            insertProject,
            findProjectByRequestId,
            holder: leaseHolder,
            preClaimed,
            creationEnabled,
          },
          {
            requestKey: requestKey || `norequest:${projectCode}`,
            workspaceId,
            requestedBy: userId,
            submission: { form, userId, statusChannel, threadTs, workspaceId },
          },
        )
        if (ensured.status === 'already_completed') {
          await client.chat.postMessage(postOpts({
            text: `:information_source: *${form.projectName}* was already created for this request — not creating it again.`,
          }))
          return
        }
        if (ensured.status === 'in_flight') return // another worker owns it
        if (!ensured.projectId) throw new Error('creation returned no project id')
        projectId = ensured.projectId
        await announce()
      }
      const { data: project } = await supabase.from('projects').select('*').eq('id', projectId).maybeSingle()
      if (!project) throw new Error('project row not found after creation')

      // ── Restart-safe replace: compute the persisted archive target ────────
      // Keyed on the PERSISTED replace_target_project_id (never findExistingProject),
      // guarded against the run's own new project — so a replay can never archive
      // the replacement. The archive itself is run as a DURABLE step below (so a
      // failed delete keeps the request incomplete, never silently completed).
      let replaceTargetId: string | null = null
      if (creationEnabled && requestKey) {
        const reqRow = await loadCreationRequest(requestKey).catch(() => null)
        const decision = reqRow ? shouldArchiveReplaceTarget(reqRow, projectId) : { archive: false, targetId: null }
        if (decision.archive) replaceTargetId = decision.targetId
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

      let serviceResults: Record<string, any> = {}
      let durableOutcome: Awaited<ReturnType<typeof runDurableProvisioning>> | null = null

      // Two-phase so the Slack canvas can be seeded with the Dropbox +
      // Frame.io links Kit just created. Phase 1: everything that produces
      // a link, in parallel. Phase 2: Slack (channel + canvas), with those
      // links passed through to the canvas fill. If Slack isn't selected,
      // phase 1 covers everything.
      const slackSelected = services.includes('slack' as ServiceKey)
      const phase1Services = services.filter((s) => s !== 'slack')
      const slackPayload = (acc: Record<string, any>) => ({
        ...provisionPayload,
        // Freshly-created (or resumed) Dropbox + Frame.io URLs so the canvas's
        // "Assets Folders" rows get filled in.
        dropboxUrl: acc.dropbox?.url,
        frameioUrl: acc.frameio?.url,
      })

      if (creationEnabled && requestKey) {
        // Durable per-service fan-out: each service's outcome is memoized in
        // project_provisioning_steps, so a Railway restart mid-provision resumes
        // ONLY the services that have not completed instead of re-running all of
        // them. The phases preserve ordering (Slack after the link-producers)
        // and the lease is heartbeated between phases (cooperative fencing).
        // Replacement cleanup is a DURABLE STEP that runs FIRST (frees the old
        // Slack slug before the Slack step). A failed archive/delete leaves it
        // 'failed' → the request stays incomplete (never silently completed) and
        // the recovery sweep retries it.
        const replaceCleanupPhase = replaceTargetId
          ? [() => [{ service: 'replace_cleanup', run: () => runReplaceCleanup(client, replaceTargetId as string, project.id) }]]
          : []
        const phases = [
          ...replaceCleanupPhase,
          () => phase1Services.map((service) => ({
            service: service as string,
            run: () => runService(service as string, provisionPayload),
          })),
          ...(slackSelected
            ? [(acc: Record<string, any>) => [{ service: 'slack', run: () => runService('slack', slackPayload(acc)) }]]
            : []),
        ]
        const requiredServices = [
          ...(replaceTargetId ? ['replace_cleanup'] : []),
          ...(services as string[]),
        ]
        durableOutcome = await runDurableProvisioning(
          { projectId: project.id, phases, requiredServices },
          {
            getSteps: getProvisioningSteps,
            claimStep: (pid, svc, inputHash) =>
              claimProvisioningStep(pid, svc, leaseHolder, { inputHash }).then((c) => ({
                ok: c.ok, fence: c.fence, status: c.status,
              })),
            recordExternalId: (pid, svc, fence, o) => recordStepExternalId(pid, svc, leaseHolder, fence, o),
            completeStep: (pid, svc, fence, patch) => completeProvisioningStep(pid, svc, leaseHolder, fence, patch),
            renew: () => renewCreationRequestLease(requestKey, leaseHolder),
          },
        )
        serviceResults = durableOutcome.results
        if (durableOutcome.abortedLostLease) {
          // Another holder reclaimed this request's lease mid-provision. Stop
          // here — that holder (or the next recovery pass) owns finishing it. Do
          // NOT bind, summarize, or mark completed, or we'd double-run.
          console.warn(`[Bolt] provisioning for ${form.projectName} yielded the lease; a newer holder will finish it.`)
          return
        }
      } else {
        // Pre-mission in-memory fan-out (creation disabled): unchanged behavior,
        // touches no migration-056/057 table.
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
          const slackResult = await runService('slack', slackPayload(serviceResults))
          serviceResults[slackResult.service] = slackResult
        }
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

      // ── Project Control: bind Master Project List row + Canvas ──
      // Only when creation is enabled (and the workbook configured). Skipped
      // entirely when disabled, so no Sheet row / binding / Canvas exclusion.
      // Binding health lives on project_control_bindings; a failure here does
      // not fail provisioning, but it IS surfaced (no false "connected").
      if (creationEnabled) {
        try {
          const bind = await bindProjectControl({
            projectId: project.id,
            submission: {
              projectNumber: form.projectNumber,
              clientName: form.clientName,
              projectName: form.projectName,
              startDate: form.startDate,
              deadline: form.deadline,
              producerName: await resolveUserDisplayName(client, form.projectManager),
              creativeDirectorName: await resolveUserDisplayName(client, form.creativeDirector),
              frameioUrl: serviceResults.frameio?.url,
              dropboxUrl: serviceResults.dropbox?.url,
            },
            slackResult: serviceResults.slack,
          })
          // Creation-time bind failures ('error') and lease contention that
          // outlived the retry window ('deferred') do NOT auto-recover — the
          // recurring sync only re-renders bindings that already reached
          // 'connected'. Surface them honestly so they are actioned, not
          // silently lost, and never claim a false auto-retry.
          if (bind.status === 'error' || bind.status === 'deferred') {
            await client.chat.postMessage(postOpts({
              text: `:warning: *${form.projectName}* is created, but its Project Control Sheet/Canvas link is incomplete (${bind.reason}) and needs attention — it will not auto-recover.`,
            }))
          }
        } catch (err: any) {
          console.error('[Bolt] project-control bind failed (non-fatal):', err?.message)
        }
      }

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

      // ── Terminal-state contract ───────────────────────────
      // Mark the request `completed` ONLY when every required provisioning step
      // reached `done` (DB-backed via the step ledger). Otherwise keep a
      // recoverable `provisioning` state so the Railway sweep retries the
      // failed/pending steps — never silently complete with unfinished work. A
      // permanent (terminal) step is surfaced explicitly. NOT swallowed: a write
      // failure here propagates to the outer catch (visible), not lost.
      if (creationEnabled && requestKey) {
        if (!durableOutcome || durableOutcome.allRequiredDone) {
          await updateCreationRequest(requestKey, { status: 'completed', error: null })
        } else {
          const kind = durableOutcome.anyTerminal ? 'terminal' : 'retryable'
          const detail = durableOutcome.incompleteServices.join(',')
          await updateCreationRequest(requestKey, {
            status: 'provisioning',
            error: `incomplete_steps(${kind}): ${detail}`,
          })
          await client.chat.postMessage(postOpts({
            text: durableOutcome.anyTerminal
              ? `:red_circle: *${form.projectName}*: ${detail} hit a permanent error and needs attention — it will not auto-complete.`
              : `:warning: *${form.projectName}*: ${detail} didn't finish; Kit will retry automatically.`,
          }))
        }
      }

    } catch (err: any) {
      console.error('[Bolt] Provisioning failed:', err)
      if (creationEnabled && requestKey) {
        await updateCreationRequest(requestKey, { status: 'error', error: err?.message || 'unknown error' }).catch(() => {})
      }
      await client.chat.postMessage(postOpts({
        text: `❌ Provisioning *${form.projectName}* failed: ${err.message || 'unknown error'}`,
      }))
    }
  }

  // ─── Railway-owned recovery sweep ──────────────────────────
  // Completes work stranded by a crash: nonterminal creation requests whose
  // lease expired, and bindings that never reached 'connected'. The Vercel sync
  // deliberately ignores both (it only re-renders connected bindings), so this
  // is Railway's to own. Everything it calls is idempotent — the durable step
  // ledger, the creation-request ledger, and bindProjectControl — so a resumed
  // request never double-provisions and a re-driven bind never double-creates.
  // Returned to app.ts, which schedules it (cron ownership stays in app.ts) but
  // needs this closure for the shared provisioning path.
  async function runProjectControlRecoverySweep() {
    if (!projectControlCreationEnabled()) return { ran: false, reason: 'disabled' as const }
    const config = workbookConfigFromEnv()
    if (!config) return { ran: false, reason: 'workbook_not_configured' as const }

    return runProjectControlRecovery({
      listRecoverableRequests,
      // Step-based discovery: find requests that still own incomplete steps even
      // if the request row looks terminal (inconsistency safety net).
      listStepRecoverableRequests: async () => {
        const projectIds = await listProjectsWithIncompleteSteps()
        const out = []
        for (const pid of projectIds) {
          const req = await loadCreationRequestByProjectId(pid)
          if (req) out.push({ ...req, request_key: req.request_key, hasIncompleteSteps: true })
        }
        return out as any
      },
      claimRequest: (rk, holder) => claimCreationRequestFenced(rk, holder),
      resumeRequest: async (r, holder) => {
        const sub: any = r.submission || {}
        const form = sub.form
        if (!form) return // nothing to resume from
        // Un-stick an INCONSISTENT completed request (found via step-based
        // discovery with incomplete steps): reset it to 'provisioning' so
        // resolveCreationProject doesn't short-circuit on 'already_completed' and
        // the durable steps actually re-run. Safe — the steps are idempotent, and
        // if they were truly all done the run re-marks completed.
        if (r.hasIncompleteSteps && r.status === 'completed') {
          await updateCreationRequest(r.request_key, { status: 'provisioning' }).catch(() => {})
        }
        // A persisted 'replace' decision is honored inside runProjectProvisioning
        // (archives the persisted replace_target_project_id, idempotently) — so
        // the resume path and the interactive path share one archive site.
        await runProjectProvisioning({
          client: app.client,
          form,
          workspaceId: sub.workspaceId || r.workspace_id || '',
          userId: sub.userId || r.requested_by_slack_user_id || '',
          statusChannel: sub.statusChannel || sub.userId || r.requested_by_slack_user_id || '',
          threadTs: sub.threadTs,
          requestKey: r.request_key,
          creationEnabled: true,
          preClaimed: true,   // the sweep already holds the lease
          leaseHolder: holder, // heartbeat the lease this sweep reclaimed
        })
      },
      listIncompleteBindings: () => listIncompleteBindings(config.spreadsheetId),
      rebind: (b) => rebindIncompleteBinding(app.client, b.project_id, config),
      makeHolder: (rk) => `recovery:${rk}:${randomUUID()}`,
    })
  }

  return { runProjectControlRecoverySweep }
}

/**
 * Re-drive a stalled Project Control binding (creation_state != 'connected') by
 * reconstructing bindProjectControl's inputs from the persisted project +
 * creation request and re-resolving the control template. Idempotent: the Sheet
 * step searches developer metadata before writing and the Canvas step reconciles
 * by title, so a re-drive completes the binding without duplicating a row/canvas.
 */
async function rebindIncompleteBinding(
  client: any,
  projectId: string,
  config: NonNullable<ReturnType<typeof workbookConfigFromEnv>>,
): Promise<void> {
  const supabase = createAdminClient()
  const { data: project } = await supabase.from('projects').select('*').eq('id', projectId).maybeSingle()
  if (!project) return
  const links: Record<string, string> = project.external_links || {}
  const channelId = links.slack_id || (links as any).slack_channel_id
  if (!channelId) throw new Error(`rebind: no Slack channel for project ${projectId}`)

  // Reconstruct the original modal form from the creation request (best-effort).
  let form: any = {}
  if (project.creation_request_id) {
    const req = await loadCreationRequest(project.creation_request_id)
    form = (req?.submission as any)?.form || {}
  }

  const t = await resolveControlTemplate(config)
  const controlTemplate = t.ok ? { fileId: t.fileId, markdown: t.markdown, hash: t.hash } : null
  const controlTemplateError = t.ok ? null : t.reason

  await bindProjectControl({
    projectId,
    submission: {
      projectNumber: form.projectNumber || String(project.project_code || '').split('-')[0] || '',
      clientName: form.clientName || project.client || '',
      projectName: form.projectName || project.name || '',
      startDate: form.startDate || project.start_date || undefined,
      deadline: form.deadline || project.target_delivery || undefined,
      producerName: await resolveUserDisplayName(client, form.projectManager),
      creativeDirectorName: await resolveUserDisplayName(client, form.creativeDirector),
      frameioUrl: links.frameio,
      dropboxUrl: links.dropbox,
    },
    slackResult: { id: channelId, data: { channelId, controlTemplate, controlTemplateError } },
  })
}

/** User-facing refusal text for an unauthorized/invalid duplicate-resolution. */
function authRefusalText(reason: string): string {
  switch (reason) {
    case 'not_found':
      return ':warning: That request expired — re-run the project form.'
    case 'wrong_workspace':
      return ':no_entry: That request belongs to a different workspace.'
    case 'not_authorized':
      return ':no_entry: Only the person who started this project request can resolve it.'
    case 'invalid_state':
      return ':information_source: That request was already resolved.'
    default:
      return ':warning: That action can\'t be completed.'
  }
}

/** Best-effort Slack display name for a user id (for Sheet Producer/CD cells). */
async function resolveUserDisplayName(client: any, userId?: string): Promise<string | undefined> {
  if (!userId) return undefined
  try {
    const r = await client.users.info({ user: userId })
    return r.user?.real_name || r.user?.profile?.display_name || undefined
  } catch {
    return undefined
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
// When Project Control creation is ENABLED, pending-provision state lives in the
// persisted project_creation_requests ledger (keyed by Slack view.id). When it
// is DISABLED, we fall back to this in-memory Map — the exact pre-mission
// behavior (single Railway process; entries TTL out after an hour; a restart
// just drops them and the producer re-runs the form). No migration-056 table is
// touched on the disabled path.

interface PendingProvision {
  form: any
  workspaceId: string
  userId: string
  statusChannel: string
  threadTs?: string
  existing: { id: string; name: string; code?: string; slackId?: string }
}

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
  includeRequestId = false,
): Promise<{ id: string; name: string; code?: string; slackId?: string; creationRequestId?: string | null } | null> {
  if (!workspaceId || !projectNumber) return null
  try {
    const sb = createAdminClient()
    // creation_request_id is a migration-056 column; only select it on the
    // enabled path (includeRequestId), so the disabled path never depends on 056.
    const cols = includeRequestId
      ? 'id, name, project_code, external_links, status, creation_request_id'
      : 'id, name, project_code, external_links, status'
    const { data } = await sb
      .from('projects')
      .select(cols)
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
      creationRequestId: includeRequestId ? ((data as any).creation_request_id ?? null) : undefined,
    }
  } catch (err: any) {
    console.warn('[provision-dup] findExistingProject failed:', err?.message)
    return null
  }
}

/**
 * Find the project a request already created, by the durable
 * projects.creation_request_id identity (migration-056 column). Covers a crash
 * whose ledger project_id link never landed, and a project whose number later
 * changed. Enabled-path only.
 */
async function findProjectIdByRequestKey(requestKey: string): Promise<string | null> {
  if (!requestKey) return null
  try {
    const sb = createAdminClient()
    const { data } = await sb
      .from('projects')
      .select('id')
      .eq('creation_request_id', requestKey)
      .maybeSingle()
    return data?.id || null
  } catch (err: any) {
    console.warn('[provision-dup] findProjectIdByRequestKey failed:', err?.message)
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
    // Rename first so the replacement can reclaim the original slug (Slack keeps
    // an archived channel's name reserved otherwise). `already_archived` /
    // `channel_not_found` are benign (idempotent re-run); any OTHER Slack error
    // is surfaced (not swallowed) so a genuinely failed archive is visible.
    await client.conversations
      .rename({ channel: existing.slackId, name: `z-archived-${existing.slackId.toLowerCase()}`.slice(0, 80) })
      .catch((err: any) => {
        const e = err?.data?.error || err?.message || ''
        if (!/already_archived|channel_not_found|name_taken/.test(String(e))) throw err
      })
    await client.conversations.archive({ channel: existing.slackId }).catch((err: any) => {
      const e = err?.data?.error || err?.message || ''
      if (!/already_archived|channel_not_found/.test(String(e))) throw err
    })
  }
  const sb = createAdminClient()
  // The record delete is the load-bearing cleanup — a failure MUST propagate so
  // the replace_cleanup step stays 'failed' and the request is not completed.
  const { error } = await sb.from('projects').delete().eq('id', existing.id)
  if (error) throw new Error(`archiveOldProject delete failed: ${error.message}`)
}

/**
 * Durable replacement-cleanup step body. Loads the persisted target and archives
 * it (idempotent; delete no-ops if already gone). Guarded so it can NEVER delete
 * the run's own replacement project. Returns a StepResult; a thrown archive/
 * delete error keeps the step 'failed' (request stays incomplete, retried).
 */
async function runReplaceCleanup(
  client: any,
  targetId: string,
  newProjectId: string,
): Promise<{ service: string; success: boolean; error?: string }> {
  // Fast-guard the two decisions that need no DB read (no target / the run's own
  // replacement) via the pure resolver, so a replay can never target the
  // replacement.
  if (resolveReplaceCleanup({ targetId, newProjectId, targetExists: true }).action === 'noop') {
    return { service: 'replace_cleanup', success: true }
  }
  const sb = createAdminClient()
  const { data: target } = await sb.from('projects').select('*').eq('id', targetId).maybeSingle()
  // Re-resolve with the observed existence: an absent target (archived + deleted
  // by a prior attempt, then a crash before the step was marked done) converges
  // idempotently to success on this resume — the persisted target id survives the
  // deletion (migration 057), so the step stayed required until it reached here.
  const decision = resolveReplaceCleanup({ targetId, newProjectId, targetExists: !!target })
  if (decision.action === 'noop') return { service: 'replace_cleanup', success: true }
  await archiveOldProject(client, {
    id: target.id,
    name: target.name,
    slackId: (target.external_links || {}).slack_id,
  })
  return { service: 'replace_cleanup', success: true }
}
