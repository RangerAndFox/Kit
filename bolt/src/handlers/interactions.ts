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
import { buildSummaryBlocks } from '../../../src/lib/provisioner/slack-summary'
import type { ServiceKey } from '../../../src/lib/provisioner/types'
import { buildNewProjectModal } from '../../../src/lib/provisioner/modal'
import { buildStoryboardModal } from '../../../src/lib/storyboard/modal'
import { peekIntake, takeIntake, updateIntake } from '../../../src/lib/storyboard/stash'
import { extractScriptFromFile } from '../../../src/lib/storyboard/files'
import { handleCheckinConfirm, handleCheckinRedo } from '../checkins/confirm'

export function registerInteractionHandlers(app: App) {
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
    const postOpts = (extra: Record<string, unknown> = {}) => ({
      channel: statusChannel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...extra,
    })
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
          external_ids: { dropbox_safe_name: dropboxSafeName },
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

      const results = await Promise.allSettled(
        services.map(async (service) => {
          try {
            const result = await dispatch(service as string, 'provision', provisionPayload)

            // Progress update
            const status = result.success ? '✅' : '⚠️'
            await client.chat.postMessage(postOpts({
              text: `${status} *${service}*: ${result.message || (result.success ? 'Done' : result.error || 'Failed')}`,
            }))

            return { service, ...result }
          } catch (err: any) {
            await client.chat.postMessage(postOpts({
              text: `❌ *${service}*: ${err.message}`,
            }))
            return {
              service,
              agent: service,
              action: 'provision',
              success: false,
              error: err.message,
            }
          }
        })
      )

      // ── Collect results ───────────────────────────────────
      const serviceResults: Record<string, any> = {}
      for (const settled of results) {
        const result = settled.status === 'fulfilled'
          ? settled.value
          : { service: 'unknown', success: false, error: settled.reason?.message }
        serviceResults[result.service] = result
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

      // ── Post summary to the project channel ───────────────
      const targetChannel = serviceResults.slack?.id || channelId
      if (targetChannel) {
        const summaryBlocks = buildSummaryBlocks(serviceResults, form.projectName)
        await client.chat.postMessage({
          channel: targetChannel,
          text: `${form.projectName} — Project Provisioned`,
          blocks: summaryBlocks as any,
        })
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
  })
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
