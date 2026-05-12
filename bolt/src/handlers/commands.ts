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
import { buildNewProjectModal } from '../../../src/lib/provisioner/modal'
import { buildStoryboardModal } from '../../../src/lib/storyboard/modal'
import { stashIntake } from '../../../src/lib/storyboard/stash'
import { dispatch } from '../../../src/lib/inngest/agents/registry'

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

        // Open the intake modal
        const modal = buildNewProjectModal(command.channel_id)

        try {
          await client.views.open({
            trigger_id: command.trigger_id,
            view: modal as any,
          })
        } catch (err: any) {
          console.error('[Bolt] views.open failed:', err.data?.error || err.message)
          await respond({
            response_type: 'ephemeral',
            text: `Failed to open the project form: ${err.data?.error || err.message}`,
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

      // ── Help ────────────────────────────────────────────────
      case 'help':
      default: {
        await ack()
        await respond({
          response_type: 'ephemeral',
          text:
            '*Kit Commands*\n\n' +
            '`/kit newproject` — Open the new project intake form\n' +
            '`/kit status <name>` — Quick project lookup\n' +
            '`/storyboard` — Turn a script into a Boords storyboard\n' +
            '`/kit help` — Show this message\n\n' +
            'You can also @mention Kit or DM me directly to ask about projects, budgets, files, reviews, or to log time.',
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
