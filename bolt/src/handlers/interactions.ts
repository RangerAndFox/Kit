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
import { formatProjectId } from '../../../src/lib/provisioner/naming'
import type { ServiceKey } from '../../../src/lib/provisioner/types'

export function registerInteractionHandlers(app: App) {
  // ─── Project Provisioning Modal ───────────────────────────
  app.view('kit_provision_project', async ({ ack, view, body, client }) => {
    // Ack immediately to dismiss the modal
    await ack()

    const userId = body.user.id
    const meta = JSON.parse(view.private_metadata || '{}')
    const channelId = meta.channel_id || ''
    const values = view.state?.values || {}

    // Extract form values. Services are no longer user-selectable — the modal
    // confirms intent and we provision every available agent that supports it.
    const form = {
      clientCode: values.client_code?.val?.value || '',
      clientName: values.client_name?.val?.value || '',
      projectNumber: values.project_number?.val?.value || '',
      shortname: values.shortname?.val?.value || '',
      projectType: values.project_type?.val?.selected_option?.value || 'Other',
      projectManager: values.project_manager?.val?.selected_user || userId,
      teamMembers: values.team_members?.val?.selected_users || [],
      startDate: values.start_date?.val?.selected_date || undefined,
      deadline: values.deadline?.val?.selected_date || undefined,
      description: values.description?.val?.value || undefined,
      selectedServices: getProvisionableServices(),
    }

    // Build the canonical project ID (the spine). This becomes the project's
    // name in every external system — Slack channel, Dropbox folder,
    // Frame.io project, Harvest project, canvas titles.
    let projectId: string
    try {
      projectId = formatProjectId({
        clientCode: form.clientCode,
        projectNumber: form.projectNumber,
        shortname: form.shortname,
      })
    } catch (err: any) {
      await client.chat.postMessage({
        channel: userId,
        text: `❌ Could not build a project ID: ${err.message}`,
      })
      return
    }

    // Resolve workspace
    const teamId = body.team?.id || ''
    const workspaceId = await resolveWorkspaceId(teamId)

    // ── Run provisioning in-process (no timeout!) ───────────
    // This is the whole point of moving to Bolt on Railway.
    // No after(), no Inngest, no 60s ceiling. Just do the work.

    try {
      // DM the user that we're starting
      await client.chat.postMessage({
        channel: userId,
        text: `⚡ Provisioning *${projectId}* for ${form.clientName}...`,
      })

      // ── Create project record in Supabase ─────────────────
      const supabase = createAdminClient()
      const { data: project, error: dbError } = await supabase
        .from('projects')
        .insert({
          workspace_id: workspaceId,
          name: projectId,
          client: form.clientName,
          project_code: projectId,
          project_type: form.projectType,
          status: 'provisioning',
          created_by: userId,
          start_date: form.startDate || null,
          deadline: form.deadline || null,
          description: form.description || null,
        })
        .select()
        .single()

      if (dbError || !project) {
        throw new Error(`Failed to create project record: ${dbError?.message || 'unknown'}`)
      }

      // ── Fan-out to agents in parallel ─────────────────────
      // The spine ID is sent as both projectName and projectCode so every
      // agent that names something uses the same identifier. Display name
      // (`client`) is sent separately for human-facing output (canvases,
      // welcome messages) and is never an identifier.
      const services = form.selectedServices
      const provisionPayload = {
        projectId: project.id,
        projectName: projectId,
        projectCode: projectId,
        client: form.clientName,
        clientName: form.clientName,
        projectType: form.projectType,
        startDate: form.startDate,
        targetDelivery: form.deadline,
        briefSummary: form.description,
        workspaceId,
      }

      console.log(`[Bolt] Provisioning ${projectId} across ${services.length} services`)

      const results = await Promise.allSettled(
        services.map(async (service) => {
          try {
            const result = await dispatch(service as string, 'provision', provisionPayload)

            // Progress update
            const status = result.success ? '✅' : '⚠️'
            await client.chat.postMessage({
              channel: userId,
              text: `${status} *${service}*: ${result.message || (result.success ? 'Done' : result.error || 'Failed')}`,
            })

            return { service, ...result }
          } catch (err: any) {
            await client.chat.postMessage({
              channel: userId,
              text: `❌ *${service}*: ${err.message}`,
            })
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
          service_links: projectLinks,
        })
        .eq('id', project.id)

      // ── Post summary to the project channel ───────────────
      const targetChannel = serviceResults.slack?.id || channelId
      if (targetChannel) {
        const summaryBlocks = buildSummaryBlocks(serviceResults, projectId)
        await client.chat.postMessage({
          channel: targetChannel,
          text: `${projectId} — Project Provisioned`,
          blocks: summaryBlocks as any,
        })
      }

      // ── Final DM ──────────────────────────────────────────
      const succeeded = Object.values(serviceResults).filter((r: any) => r.success).length
      const failed = services.length - succeeded
      await client.chat.postMessage({
        channel: userId,
        text: failed === 0
          ? `✅ *${projectId}* is fully provisioned! (${succeeded}/${services.length} services)`
          : `⚠️ *${projectId}* provisioned with ${failed} issue(s). Check the project channel for details.`,
      })

    } catch (err: any) {
      console.error('[Bolt] Provisioning failed:', err)
      await client.chat.postMessage({
        channel: userId,
        text: `❌ Provisioning *${projectId}* failed: ${err.message || 'unknown error'}`,
      })
    }
  })
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Every registered agent (with required env vars present) that declares a
 * `provision` capability. Single source of truth — adding a new agent with
 * provision support automatically extends the new-project flow.
 */
function getProvisionableServices(): ServiceKey[] {
  return getAvailableAgents()
    .filter((agent) => agent.capabilities.some((c) => c.action === 'provision'))
    .map((agent) => agent.id as ServiceKey)
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
