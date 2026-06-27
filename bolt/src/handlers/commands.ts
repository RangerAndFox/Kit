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
import { handleShotListMessage } from '../shotlist/handler'
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

      // ── Shot List ───────────────────────────────────────────
      case 'shotlist':
      case 'shots': {
        await ack()
        try {
          await handleShotListMessage({
            app: { client } as any,
            channelId: command.channel_id,
            userId: command.user_id,
            text: args || 'create a new empty shot list',
          })
        } catch (err: any) {
          console.error('[Bolt] /kit shotlist failed:', err.data?.error || err.message)
          await respond({
            response_type: 'ephemeral',
            text: `Shot list failed: ${err.data?.error || err.message}`,
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
            '`/kit shotlist <script>` — Build a shot list canvas in this channel\n' +
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
