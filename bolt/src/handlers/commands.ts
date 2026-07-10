// @ts-nocheck
/**
 * Bolt Command Handlers
 *
 * Handles slash commands. Currently supports:
 *   /kit newproject — opens the project intake modal
 *   /kit status     — quick project health check
 *   /kit help       — lists available commands
 *
 * Bolt handles signature verification and ack() automatically.
 * No need for manual parsing — everything is typed.
 */

import type { App } from '@slack/bolt'
import { buildStoryboardModal } from '../../../src/lib/storyboard/modal'
import { stashIntake } from '../../../src/lib/storyboard/stash'
import { dispatch } from '../../../src/lib/inngest/agents/registry'
import { buildNewProjectCard } from './newproject-card'
import { buildOnboardModal } from '../onboarding/modal'
import { canOnboard } from '../onboarding/permissions'
import { handleNoteMessage } from '../notes/handler'
import { buildSelectProfileModal } from '../delivery/select-profile-modal'
import { buildCreateProfileModal } from '../delivery/create-profile-modal'
import { renderJobsStatusBlocks, renderWorkersStatusBlocks } from '../delivery/status'
import { setWorkerOptOut, setWorkerOptIn, listProfiles } from '../../../src/lib/delivery/storage'
import { listAeRenders, getAeRenderStatus } from '../../../src/lib/delivery/ae-storage'
import { buildRenderModal } from '../delivery/render-modal'

/**
 * Resolve the Slack user's Kit access context for a slash command.
 *
 * CRITICAL: we look up the user's email FIRST and pass it to
 * resolveUserContext. Without the email, the hardcoded-admin override
 * (the founders, e.g. steve@rangerandfox.tv) can't fire — and since
 * team_members may be empty, the founder would otherwise resolve to the
 * artist failsafe and get locked out of their own studio's Brain. The
 * @-mention path already does this; slash commands must too.
 */
async function resolveCommandUser(client: any, workspaceId: string, slackUserId: string) {
  const { resolveUserContext, failsafeArtistContext } = await import('../../../src/lib/inngest/access-control')
  let email: string | undefined
  try {
    const info = await client.users.info({ user: slackUserId })
    email = info.user?.profile?.email || undefined
  } catch (err: any) {
    console.warn('[Bolt] resolveCommandUser users.info failed:', err?.data?.error || err?.message)
  }
  return (await resolveUserContext(workspaceId, slackUserId, email)) ?? failsafeArtistContext(workspaceId, slackUserId)
}

export function registerCommandHandlers(app: App) {
  // ─── /kit ─────────────────────────────────────────────────
  app.command('/kit', async ({ command, ack, client, respond }) => {
    const subcommand = (command.text || '').trim().split(/\s+/)[0]?.toLowerCase() || 'help'
    const args = (command.text || '').trim().split(/\s+/).slice(1).join(' ')

    switch (subcommand) {
      // ── New Project ─────────────────────────────────────────
      case 'newproject':
      case 'new': {
        // Ack immediately — Slack needs a response within 3s
        await ack()
        // Post the new-project card; the button click opens the modal
        // with a fresh trigger_id. Same UX as the storyboard flow and
        // as typing "new project" in a DM.
        try {
          await client.chat.postMessage(
            buildNewProjectCard(command.channel_id),
          )
        } catch (err: any) {
          console.error('[Bolt] newproject card post failed:', err.data?.error || err.message)
          await respond({
            response_type: 'ephemeral',
            text: `Couldn't post the new-project card: ${err.data?.error || err.message}`,
          })
        }
        break
      }

      // ── Onboard Freelancer ──────────────────────────────────
      case 'onboard': {
        await ack()
        // Permission check
        const allowed = await canOnboard(command.user_id)
        if (!allowed) {
          await respond({
            response_type: 'ephemeral',
            text:
              ":lock: Onboarding is restricted to PMs, CDs, and admins. If that's you and you're seeing this, your role isn't set in the staff directory yet.",
          })
          break
        }
        try {
          const view = await buildOnboardModal({ channelId: command.channel_id })
          await client.views.open({ trigger_id: command.trigger_id, view })
        } catch (err: any) {
          console.error('[Bolt] onboard views.open failed:', err.data?.error || err.message)
          await respond({
            response_type: 'ephemeral',
            text: `Couldn't open the onboarding form: ${err.data?.error || err.message}`,
          })
        }
        break
      }

      // ── Project Status ──────────────────────────────────────
      case 'status': {
        await ack()

        if (!args) {
          await respond({
            response_type: 'ephemeral',
            text: 'Usage: `/kit status <project name or code>`',
          })
          return
        }

        try {
          // Ask Harvest for project info
          const result = await dispatch('harvest', 'find_projects', { query: args })
          if (result.success && result.data) {
            const projects = Array.isArray(result.data.projects)
              ? result.data.projects
              : [result.data]
            const summaries = projects.slice(0, 3).map((p: any) =>
              `• *${p.name || p.code || 'Unknown'}* — ${p.status || 'active'}`
            )
            await respond({
              response_type: 'ephemeral',
              text: summaries.length
                ? `Found ${summaries.length} project(s):\n${summaries.join('\n')}`
                : `No projects found matching "${args}"`,
            })
          } else {
            await respond({
              response_type: 'ephemeral',
              text: result.error || `Couldn't find projects matching "${args}"`,
            })
          }
        } catch (err: any) {
          console.error('[Bolt] status command error:', err)
          await respond({
            response_type: 'ephemeral',
            text: `Error looking up status: ${err.message}`,
          })
        }
        break
      }

      // ── Delivery ────────────────────────────────────────────
      case 'deliver': {
        await ack()
        const subArg = (args || '').trim()
        if (subArg.toLowerCase() === 'status') {
          const blocks = await renderJobsStatusBlocks()
          await client.chat.postMessage({
            channel: command.channel_id,
            blocks,
            text: 'Delivery status',
          })
          break
        }
        // Otherwise open the profile-selection modal
        try {
          const view = await buildSelectProfileModal({
            sourcePath: subArg && subArg !== 'status' ? subArg : undefined,
            channelId: command.channel_id,
          })
          await client.views.open({ trigger_id: command.trigger_id, view })
        } catch (err: any) {
          console.error('[Bolt] /kit deliver failed:', err.data?.error || err.message)
          await respond({
            response_type: 'ephemeral',
            text: `Couldn't open delivery modal: ${err.data?.error || err.message}`,
          })
        }
        break
      }

      // ── Profiles ────────────────────────────────────────────
      case 'profiles': {
        await ack()
        const subArg = (args || '').trim().toLowerCase()
        if (subArg === 'create') {
          try {
            await client.views.open({
              trigger_id: command.trigger_id,
              view: buildCreateProfileModal(),
            })
          } catch (err: any) {
            await respond({
              response_type: 'ephemeral',
              text: `Couldn't open profile-creation modal: ${err.data?.error || err.message}`,
            })
          }
        } else {
          // List profiles
          const profiles = await listProfiles(false)
          if (profiles.length === 0) {
            await respond({ response_type: 'ephemeral', text: 'No delivery profiles. `/kit profiles create` to make one.' })
            break
          }
          const lines = profiles.map((p) => `• *${p.name}* — ${p.description || '_no description_'}`).join('\n')
          await respond({ response_type: 'ephemeral', text: `*Delivery profiles*\n${lines}` })
        }
        break
      }

      // ── Workers ─────────────────────────────────────────────
      case 'workers': {
        await ack()
        const subArg = (args || '').trim().split(/\s+/)
        const subCmd = (subArg[0] || '').toLowerCase()
        if (subCmd === 'opt-out' && subArg[1]) {
          await setWorkerOptOut(subArg[1], command.user_id, subArg.slice(2).join(' ') || 'no reason')
          await respond({ response_type: 'ephemeral', text: `:white_circle: \`${subArg[1]}\` opted out.` })
        } else if (subCmd === 'opt-in' && subArg[1]) {
          await setWorkerOptIn(subArg[1])
          await respond({ response_type: 'ephemeral', text: `:large_green_circle: \`${subArg[1]}\` opted back in.` })
        } else {
          const blocks = await renderWorkersStatusBlocks()
          await client.chat.postMessage({
            channel: command.channel_id,
            blocks,
            text: 'Render worker status',
          })
        }
        break
      }

      // ── After Effects render farm ───────────────────────────
      case 'render': {
        const raw = (args || '').trim()

        // `/kit render status` — recent render-farm jobs
        if (raw.toLowerCase() === 'status') {
          await ack()
          const renders = await listAeRenders(10)
          if (renders.length === 0) {
            await respond({ response_type: 'ephemeral', text: 'No After Effects renders yet. Run `/kit render` to start one.' })
            break
          }
          const lines = await Promise.all(
            renders.map(async (r: any) => {
              const st = await getAeRenderStatus(r.id)
              const label = r.ae_comp || (r.ae_project_path ? r.ae_project_path.split('/').pop() : 'render')
              const done = st && st.chunksTotal ? ` (${st.chunksComplete}/${st.chunksTotal} chunks · ${st.percent}%)` : ''
              return `• *${label}* — ${r.status}${done}`
            }),
          )
          await respond({ response_type: 'ephemeral', text: `*After Effects renders*\n${lines.join('\n')}` })
          break
        }

        // Otherwise open the render modal (prefill the .aep path if one was typed).
        await ack()
        try {
          await client.views.open({
            trigger_id: command.trigger_id,
            view: buildRenderModal({ projectPath: raw || undefined, channelId: command.channel_id }),
          })
        } catch (err: any) {
          console.error('[Bolt] /kit render failed:', err.data?.error || err.message)
          await respond({ response_type: 'ephemeral', text: `Couldn't open the render modal: ${err.data?.error || err.message}` })
        }
        break
      }

      // ── Accessibility (captions + DV) ───────────────────────
      case 'access':
      case 'accessibility': {
        await ack()
        const sub = (args || '').trim().toLowerCase()
        const { createAdminClient } = await import('../../../src/lib/supabase/admin')
        const sb = createAdminClient()
        if (sub === '' || sub === 'status') {
          const { data: rows } = await sb
            .from('accessibility_jobs')
            .select('id, status, source_video_path, progress_percent, progress_message, output_folder_path, error_message, created_at')
            .order('created_at', { ascending: false })
            .limit(10)
          if (!rows || rows.length === 0) {
            await respond({
              response_type: 'ephemeral',
              text: 'No accessibility jobs yet. Drop a video in `/Accessibility-Queue/` on Dropbox to start one.',
            })
            break
          }
          const lines = rows.map((j: any) => {
            const file = (j.source_video_path || '').split('/').pop() || j.source_video_path
            if (j.status === 'complete') {
              return `:white_check_mark: \`${file}\` → \`${j.output_folder_path}\``
            }
            if (j.status === 'failed') {
              return `:x: \`${file}\` — ${j.error_message || 'failed'}`
            }
            return `:hourglass_flowing_sand: \`${file}\` — ${j.status} (${j.progress_percent ?? 0}% — ${j.progress_message || ''})`
          })
          await respond({
            response_type: 'ephemeral',
            text: `*Accessibility jobs (last ${rows.length})*\n${lines.join('\n')}`,
          })
        } else {
          await respond({
            response_type: 'ephemeral',
            text: 'Usage: `/kit access status` — list recent accessibility jobs.',
          })
        }
        break
      }

      // ── Brain ───────────────────────────────────────────────
      case 'brain': {
        await ack()
        const sub = (args || '').trim()
        const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
        if (!workspaceId) {
          await respond({
            response_type: 'ephemeral',
            text: ':warning: `KIT_DEFAULT_WORKSPACE_ID` is not set — set it in Railway before running `/kit brain`.',
          })
          break
        }

        // Tier gate — Brain is visible to producers AND owners/admins.
        // (Artists are blocked.) Email is resolved inside the helper so the
        // founder override works even when team_members is empty.
        const user = await resolveCommandUser(client, workspaceId, command.user_id)
        if (user.tier === 'artist') {
          await respond({
            response_type: 'ephemeral',
            text: ":lock: The project Brain is restricted to producers and admins. If you should have access, ask an admin to set your role via `/kit role @you producer`.",
          })
          break
        }

        // `/kit brain why <claim>` — provenance lookup
        if (sub.toLowerCase().startsWith('why')) {
          const claim = sub.replace(/^why\s*/i, '').trim()
          if (!claim) {
            await respond({
              response_type: 'ephemeral',
              text: 'Usage: `/kit brain why <claim>` — looks up the sources behind a fact in this channel\'s brain.',
            })
            break
          }
          const result = await dispatch('brain', 'why', { claim, channelId: command.channel_id, workspaceId })
          await respond({
            response_type: 'ephemeral',
            text: result.success && result.data?.message
              ? result.data.message
              : result.error || 'No sources found.',
          })
          break
        }

        // `/kit brain visibility team|producers_only` — flip the per-brain policy
        if (sub.toLowerCase().startsWith('visibility')) {
          const target = sub.replace(/^visibility\s*/i, '').trim().toLowerCase()
          if (target !== 'team' && target !== 'producers_only') {
            await respond({
              response_type: 'ephemeral',
              text: 'Usage: `/kit brain visibility team` (channel canvas, visible to everyone in the channel) or `/kit brain visibility producers_only` (no canvas; producer/admin only).',
            })
            break
          }
          const { getBrainByChannel } = await import('../../../src/lib/brain/store')
          const { createAdminClient } = await import('../../../src/lib/supabase/admin')
          const loaded = await getBrainByChannel(workspaceId, command.channel_id)
          if (!loaded) {
            await respond({ response_type: 'ephemeral', text: 'No brain exists for this channel yet. Run `/kit brain` first.' })
            break
          }
          const sb = createAdminClient()
          await sb.from('brains').update({ visibility: target, updated_at: new Date().toISOString() }).eq('id', loaded.row.id)
          await respond({
            response_type: 'ephemeral',
            text: `:brain: Brain visibility set to *${target}*.${target === 'producers_only' ? ' The channel canvas tab is no longer maintained — refreshes go to producers via `/kit brain` text output.' : ' Channel canvas will refresh next time the brain updates.'}`,
          })
          break
        }

        try {
          const { seedBrainForChannel } = await import('../../../src/lib/brain/seed')
          const { createOrUpdateBrainCanvas } = await import('../../../src/lib/brain/canvas')
          const { setCanvasHandle } = await import('../../../src/lib/brain/store')
          const { stripProvenance, serializeBrain } = await import('../../../src/lib/brain/format')

          const { loaded, created } = await seedBrainForChannel({
            workspaceId,
            slackChannelId: command.channel_id,
            author: command.user_id,
          })

          // producers_only: no canvas, return a text dump only the
          // requester sees (ephemeral). Channel artists never see this.
          if (loaded.row.visibility === 'producers_only') {
            const body = stripProvenance(serializeBrain(loaded.brain))
            const trimmed = body.length > 3500 ? body.slice(0, 3500) + '\n\n…(truncated)' : body
            await respond({
              response_type: 'ephemeral',
              text: `:lock: *Brain (producers_only)* — revision ${loaded.row.revision}\n\n\`\`\`\n${trimmed}\n\`\`\`\n\n_Flip to channel-visible with_ \`/kit brain visibility team\`.`,
            })
            break
          }

          const handle = await createOrUpdateBrainCanvas({
            app: { client } as any,
            channelId: command.channel_id,
            brain: loaded.brain,
            existingCanvasId: loaded.row.canvas_id,
          })

          if (handle.canvas_id !== loaded.row.canvas_id || handle.canvas_url !== loaded.row.canvas_url) {
            await setCanvasHandle(loaded.row.id, handle.canvas_id, handle.canvas_url)
          }

          const link = handle.canvas_url ? `<${handle.canvas_url}|open canvas>` : 'open this channel\'s Canvas tab'
          await respond({
            response_type: 'ephemeral',
            text: created
              ? `:brain: Brain seeded for this channel — ${link}. Every bullet carries a source tag.`
              : `:brain: Brain refreshed — ${link}. Current revision: ${loaded.row.revision}.`,
          })
        } catch (err: any) {
          console.error('[Bolt] /kit brain failed:', err.data?.error || err.message)
          await respond({
            response_type: 'ephemeral',
            text: `Brain failed: ${err.data?.error || err.message}`,
          })
        }
        break
      }

      // ── Role (admin-only) ───────────────────────────────────
      case 'role': {
        await ack()
        const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
        if (!workspaceId) {
          await respond({ response_type: 'ephemeral', text: ':warning: `KIT_DEFAULT_WORKSPACE_ID` is not set.' })
          break
        }
        const caller = await resolveCommandUser(client, workspaceId, command.user_id)
        if (caller.tier !== 'admin') {
          await respond({ response_type: 'ephemeral', text: ':lock: Only admins can change roles.' })
          break
        }

        // Parse: `<@U07...|name> producer` or `<@U07...> producer`
        const match = (args || '').match(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>\s*(\w+)?/i)
        if (!match) {
          await respond({
            response_type: 'ephemeral',
            text: 'Usage: `/kit role @user producer|artist|admin|freelancer`. Omit the role to see their current one. (You can also just tell me in chat: "make @user a producer".)',
          })
          break
        }
        const targetSlackId = match[1]
        const targetRoleRaw = (match[2] || '').trim()

        const { setTeamMemberRole, getTeamMemberRole, normalizeRoleInput, tierLabelForRole } =
          await import('../../../src/lib/inngest/access-control')

        if (!targetRoleRaw) {
          const current = await getTeamMemberRole(workspaceId, targetSlackId)
          if (!current) {
            await respond({ response_type: 'ephemeral', text: `<@${targetSlackId}> isn't in the staff directory yet (defaults to artist). \`/kit role @user <role>\` to set one.` })
          } else {
            await respond({ response_type: 'ephemeral', text: `<@${targetSlackId}> — current role: *${tierLabelForRole(current.role)}*${current.name ? ` (${current.name})` : ''}.` })
          }
          break
        }

        const targetRole = normalizeRoleInput(targetRoleRaw)
        if (!targetRole) {
          await respond({
            response_type: 'ephemeral',
            text: `\`${targetRoleRaw}\` isn't a valid role. Use one of: \`producer\`, \`artist\`, \`admin\`, \`freelancer\`.`,
          })
          break
        }

        try {
          let email: string | undefined
          let name: string | undefined
          try {
            const tinfo = await client.users.info({ user: targetSlackId })
            email = tinfo.user?.profile?.email || undefined
            name = tinfo.user?.profile?.real_name || tinfo.user?.real_name || tinfo.user?.name || undefined
          } catch { /* fall back to synthetic email inside setTeamMemberRole */ }
          await setTeamMemberRole(workspaceId, targetSlackId, targetRole, { email, name })
          await respond({
            response_type: 'ephemeral',
            text: `:white_check_mark: <@${targetSlackId}> set to *${tierLabelForRole(targetRole)}*.`,
          })
        } catch (err: any) {
          await respond({ response_type: 'ephemeral', text: `Couldn't set that role: ${err?.message || 'unknown error'}` })
        }
        break
      }

      // ── Notes ───────────────────────────────────────────────
      // ── Staff ↔ Harvest sync (admin) ────────────────────────
      // Backfills staff.harvest_user_id by email/alias match against active
      // Harvest users — the data prerequisite for the whole time-tracking
      // suite (5pm check-in, missing-time monitor, ad-hoc logging).
      case 'sync-staff':
      case 'syncstaff': {
        await ack()
        const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
        if (!workspaceId) {
          await respond({ response_type: 'ephemeral', text: ':warning: `KIT_DEFAULT_WORKSPACE_ID` is not set.' })
          break
        }
        const caller = await resolveCommandUser(client, workspaceId, command.user_id)
        if (caller.tier !== 'admin') {
          await respond({ response_type: 'ephemeral', text: ':lock: Only admins can run the staff sync.' })
          break
        }
        try {
          const { syncStaffHarvestIds } = await import('../../../src/lib/staff/sync')
          const res = await syncStaffHarvestIds()
          const lines: string[] = [':card_index_dividers: *Staff ↔ Harvest sync*']
          if (res.updated.length > 0) {
            lines.push(
              `*Mapped ${res.updated.length}:*`,
              ...res.updated.map((u) => `• ${u.name} (${u.email}) → Harvest #${u.harvestId}`),
            )
          }
          if (res.alreadyMapped > 0) lines.push(`Already mapped: ${res.alreadyMapped}`)
          if (res.unmatched.length > 0) {
            lines.push(
              `*No Harvest match (check their Harvest email or add an alias):*`,
              ...res.unmatched.map((u) => `• ${u.name} (${u.email})`),
            )
          }
          if (res.updated.length === 0 && res.unmatched.length === 0) {
            lines.push('Everyone active is already mapped. :white_check_mark:')
          }

          // Ensure the whole team is assigned to every active Harvest
          // project (studio policy — assignment friction blocks time entry).
          try {
            const { ensureAllUserAssignments } = await import('../../../src/lib/harvest/client')
            const ass = await ensureAllUserAssignments()
            lines.push(
              ass.assigned > 0
                ? `Harvest assignments: added ${ass.assigned} across ${ass.projects} active projects.`
                : `Harvest assignments: everyone already on all ${ass.projects} active projects. :white_check_mark:`,
            )
          } catch (assErr: any) {
            lines.push(`:warning: Harvest assignment sweep failed: ${assErr?.message || assErr}`)
          }

          // Refresh everyone's timezone from their Slack profile while we're
          // here — check-in timing and date resolution are per-person.
          try {
            const { resolveUserTimezone } = await import('../checkins/user-tz')
            const sbAdmin = (await import('../../../src/lib/supabase/admin')).createAdminClient()
            const { data: allStaff } = await sbAdmin
              .from('staff')
              .select('slack_user_id')
              .eq('is_active', true)
              .not('slack_user_id', 'is', null)
            const tzs = new Map<string, number>()
            for (const s of allStaff || []) {
              const tz = await resolveUserTimezone({ app: { client } as any, slackUserId: s.slack_user_id })
              tzs.set(tz, (tzs.get(tz) || 0) + 1)
            }
            if (tzs.size > 0) {
              lines.push(
                `Timezones refreshed: ${[...tzs.entries()].map(([tz, n]) => `${tz} ×${n}`).join(', ')}`,
              )
            }
          } catch (tzErr: any) {
            console.warn('[Bolt] sync-staff tz refresh failed:', tzErr?.message || tzErr)
          }

          await respond({ response_type: 'ephemeral', text: lines.join('\n') })
        } catch (err: any) {
          console.error('[Bolt] /kit sync-staff failed:', err?.message || err)
          await respond({
            response_type: 'ephemeral',
            text: `Sync failed: ${err?.message || err}`,
          })
        }
        break
      }

      case 'backfill-time':
      case 'backfilltime': {
        await ack()
        const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
        if (!workspaceId) {
          await respond({ response_type: 'ephemeral', text: ':warning: `KIT_DEFAULT_WORKSPACE_ID` is not set.' })
          break
        }
        const caller = await resolveCommandUser(client, workspaceId, command.user_id)
        if (caller.tier !== 'admin') {
          await respond({ response_type: 'ephemeral', text: ':lock: Only admins can run the time backfill.' })
          break
        }
        // Default is a safe PREVIEW. `run` (or `confirm`) actually writes.
        const doWrite = /\b(run|confirm|write|go)\b/i.test(args || '')
        try {
          const { backfillCheckins } = await import('../checkins/backfill')
          const res = await backfillCheckins({ dryRun: !doWrite })
          const lines: string[] = [
            doWrite
              ? ':white_check_mark: *Time backfill — logged to Harvest*'
              : ':mag: *Time backfill preview* (nothing written — run `/kit backfill-time run` to log)',
          ]
          const shown = doWrite ? res.logged.map((l) => ({ ...l.plan, entryId: l.entryId })) : res.planned
          if (shown.length > 0) {
            lines.push(
              `*Entries (${shown.length}):*`,
              ...shown.map(
                (p: any) =>
                  `• ${p.staffName} — ${p.hours}h ${p.projectName} on ${p.date}${p.entryId ? ` → Harvest #${p.entryId}` : ''}`,
              ),
            )
          } else {
            lines.push('No confirmable back-times found.')
          }
          if (res.duplicatesCollapsed > 0) lines.push(`Duplicate rows collapsed: ${res.duplicatesCollapsed}`)
          if (res.skippedRows.length > 0) {
            lines.push(
              `*Skipped (can't auto-log):*`,
              ...res.skippedRows.map((s) => `• ${s.staffName} ${s.date} — ${s.reason}`),
            )
          }
          if (res.failures.length > 0) {
            lines.push(
              `*Failed:*`,
              ...res.failures.map((f) => `• ${f.plan.staffName} ${f.plan.hours}h ${f.plan.projectName} — ${f.error}`),
            )
          }
          await respond({ response_type: 'ephemeral', text: lines.join('\n') })
        } catch (err: any) {
          console.error('[Bolt] /kit backfill-time failed:', err?.message || err)
          await respond({ response_type: 'ephemeral', text: `Backfill failed: ${err?.message || err}` })
        }
        break
      }

      case 'sync-projects':
      case 'syncprojects': {
        await ack()
        const workspaceId = process.env.KIT_DEFAULT_WORKSPACE_ID
        if (!workspaceId) {
          await respond({ response_type: 'ephemeral', text: ':warning: `KIT_DEFAULT_WORKSPACE_ID` is not set.' })
          break
        }
        const caller = await resolveCommandUser(client, workspaceId, command.user_id)
        if (caller.tier !== 'admin') {
          await respond({ response_type: 'ephemeral', text: ':lock: Only admins can run the project sync.' })
          break
        }
        // Default is a safe PREVIEW. `run` (or `confirm`) actually writes.
        const doWrite = /\b(run|confirm|write|go)\b/i.test(args || '')
        try {
          const { syncProjectsFromHarvest } = await import('../../../src/lib/studio-knowledge/project-sync')
          const res = await syncProjectsFromHarvest({ dryRun: !doWrite })
          const lines: string[] = [
            doWrite
              ? ':card_index_dividers: *Project sync — applied*'
              : ':mag: *Project sync preview* (nothing written — run `/kit sync-projects run` to apply)',
            `_Insert ${res.toInsert.length} · link ${res.toLink.length} · already linked ${res.alreadyLinked} · ambiguous ${res.ambiguous.length}_`,
          ]
          if (res.toInsert.length > 0) {
            lines.push(
              `*New projects (in Harvest, missing from Supabase):*`,
              ...res.toInsert.slice(0, 20).map((p) => `• ${p.code || '—'} — ${p.name}${p.client ? ` (${p.client})` : ''}`),
            )
            if (res.toInsert.length > 20) lines.push(`…and ${res.toInsert.length - 20} more`)
          }
          if (res.toLink.length > 0) {
            lines.push(
              `*Linking existing rows (backfilling harvest_project_id):*`,
              ...res.toLink.slice(0, 15).map((p) => `• ${p.code || '—'} — ${p.name}`),
            )
            if (res.toLink.length > 15) lines.push(`…and ${res.toLink.length - 15} more`)
          }
          if (res.ambiguous.length > 0) {
            lines.push(
              `*Skipped (ambiguous — reconcile by hand):*`,
              ...res.ambiguous.slice(0, 15).map((a) => `• ${a.harvest} — ${a.reason}`),
            )
            if (res.ambiguous.length > 15) lines.push(`…and ${res.ambiguous.length - 15} more`)
          }
          if (doWrite) lines.push(`:white_check_mark: Done: ${res.inserted} inserted, ${res.linked} linked.`)
          await respond({ response_type: 'ephemeral', text: lines.join('\n') })
        } catch (err: any) {
          console.error('[Bolt] /kit sync-projects failed:', err?.message || err)
          await respond({ response_type: 'ephemeral', text: `Project sync failed: ${err?.message || err}` })
        }
        break
      }

      case 'note': {
        await ack()
        // Treat the entire `args` string as the note body, optionally with
        // "<project> | <body>" split. Pipe-separated is unambiguous; if no
        // pipe is present, treat the channel as the implicit project.
        let text = args
        if (args && args.includes('|')) {
          const [projectHint, body] = args.split('|').map((s) => s.trim())
          if (projectHint && body) {
            // Reconstruct as the "note for X: Y" form so the same parser handles it
            text = `note for ${projectHint}: ${body}`
          }
        } else if (args && !/^note(\s*:|\s+for\b)/i.test(args)) {
          // Bare body — prefix "note:" so the parser picks it up
          text = `note: ${args}`
        }
        try {
          await handleNoteMessage({
            app: { client } as any,
            channelId: command.channel_id,
            userId: command.user_id,
            text,
          })
        } catch (err: any) {
          console.error('[Bolt] /kit note failed:', err.data?.error || err.message)
          await respond({
            response_type: 'ephemeral',
            text: `Note failed: ${err.data?.error || err.message}`,
          })
        }
        break
      }

      // ── Help ────────────────────────────────────────────────
      case 'help':
      default: {
        await ack()
        await respond({
          response_type: 'ephemeral',
          text:
            '*Kit Commands*\n\n' +
            '`/kit newproject` — Post the new-project card (pick services, fill in details)\n' +
            '`/kit onboard` — Onboard a freelancer to a project (Slack/Dropbox/Frame.io/Harvest)\n' +
            '`/kit status <name>` — Quick project lookup\n' +
            '`/kit note [project | body]` — Save a freeform note to a project (or current channel\'s project)\n' +
            '`/storyboard` — Turn a script into a Boords storyboard\n' +
            '`/kit deliver [path]` — Submit a transcode job (or run `/kit deliver status` for queue)\n' +
            '`/kit profiles` — List delivery profiles · `/kit profiles create` to add one\n' +
            '`/kit workers` — Show render worker fleet · `opt-out <host>` / `opt-in <host>`\n' +
            '`/kit render` — Render an After Effects project on the farm (reads its render queue; `/kit render status` for jobs)\n' +
            '`/kit access status` — Status of accessibility jobs (captions + DV)\n' +
            '`/kit brain` — Open or refresh this channel\'s living project brain (producer/admin only)\n' +
            '`/kit brain why <claim>` — Show the sources behind a fact in the brain\n' +
            '`/kit brain visibility team|producers_only` — Producer toggle for whether the channel canvas is created\n' +
            '`/kit role @user producer|artist|admin|freelancer` — Admin only: assign a role\n' +
            '`/kit sync-staff` — Admin only: map staff to Harvest users by email (activates hours check-ins)\n' +
            '`/kit sync-projects` — Admin only: preview Harvest→Supabase project reconciliation; `run` to apply\n' +
            '`/kit backfill-time` — Admin only: preview confirmable back-dated check-ins; `run` to log them to Harvest\n' +
            '`/kit help` — Show this message\n\n' +
            'You can also DM me and type *new project* or *new storyboard* to get the same cards. Or @mention me to ask about projects, budgets, files, reviews, or to log time.',
        })
        break
      }
    }
  })

  // ─── /storyboard ──────────────────────────────────────────
  // Opens the storyboard settings modal with no script attached;
  // the user can paste a script into the multiline field or leave
  // it blank for a placeholder storyboard.
  app.command('/storyboard', async ({ command, ack, client, respond }) => {
    await ack()

    const args = (command.text || '').trim()

    // Resume path: `/storyboard resume <jobId>`
    if (/^resume\b/i.test(args)) {
      const jobId = args.replace(/^resume\s+/i, '').trim()
      if (!jobId) {
        await respond({
          response_type: 'ephemeral',
          text: 'Usage: `/storyboard resume <jobId>`',
        })
        return
      }
      try {
        const result = await dispatch('boords', 'resume', { jobId })
        if (result.success) {
          const url = (result as any).url
          await respond({
            response_type: 'ephemeral',
            text: url
              ? `${result.message || 'Resumed.'} → ${url}`
              : result.message || 'Resumed.',
          })
        } else {
          await respond({
            response_type: 'ephemeral',
            text: `Couldn't resume: ${result.error || 'unknown error'}`,
          })
        }
      } catch (err: any) {
        console.error('[Bolt] /storyboard resume failed:', err)
        await respond({
          response_type: 'ephemeral',
          text: `Resume failed: ${err.message || String(err)}`,
        })
      }
      return
    }

    const stashToken = stashIntake({
      channelId: command.channel_id,
      userId: command.user_id,
    })

    try {
      await client.views.open({
        trigger_id: command.trigger_id,
        view: buildStoryboardModal({ stashToken, scriptAttached: false }) as any,
      })
    } catch (err: any) {
      console.error('[Bolt] storyboard views.open failed:', err.data?.error || err.message)
      await respond({
        response_type: 'ephemeral',
        text: `Couldn't open the storyboard form: ${err.data?.error || err.message}`,
      })
    }
  })
}
