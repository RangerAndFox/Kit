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
      projectNumber: values.project_number?.val?.value || '',
      projectName: values.project_name?.val?.value || '',
      clientName: values.client_name?.val?.value || '',
      projectType: values.project_type?.val?.selected_option?.value || 'Other',
      projectManager: values.project_manager?.val?.selected_user || userId,
      teamMembers: values.team_members?.val?.selected_users || [],
      startDate: values.start_date?.val?.selected_date || undefined,
      deadline: values.deadline?.val?.selected_date || undefined,
      description: values.description?.val?.value || undefined,
      selectedServices: getProvisionableServices(),
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
        text: `⚡ Provisioning *${form.projectName}* for ${form.clientName}...`,
      })

      // Build the project code
      const projectCode = `${form.projectNumber}-${form.clientName.replace(/\s+/g, '')}`

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
        briefSummary: form.description,
      }

      console.log(`[Bolt] Provisioning ${form.projectName} across ${services.length} services`)

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
        const summaryBlocks = buildSummaryBlocks(serviceResults, form.projectName)
        await client.chat.postMessage({
          channel: targetChannel,
          text: `${form.projectName} — Project Provisioned`,
          blocks: summaryBlocks as any,
        })
      }

      // ── Final DM ──────────────────────────────────────────
      const succeeded = Object.values(serviceResults).filter((r: any) => r.success).length
      const failed = services.length - succeeded
      await client.chat.postMessage({
        channel: userId,
        text: failed === 0
          ? `✅ *${form.projectName}* is fully provisioned! (${succeeded}/${services.length} services)`
          : `⚠️ *${form.projectName}* provisioned with ${failed} issue(s). Check the project channel for details.`,
      })

    } catch (err: any) {
      console.error('[Bolt] Provisioning failed:', err)
      await client.chat.postMessage({
        channel: userId,
        text: `❌ Provisioning *${form.projectName}* failed: ${err.message || 'unknown error'}`,
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
