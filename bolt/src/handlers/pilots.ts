// @ts-nocheck
/**
 * Bolt adapter for the Pilots capability — `/kit pilot …`.
 *
 * DELIBERATELY THIN: it resolves the feature gate + authenticated actor and
 * delegates the entire command path to the tested dispatcher
 * (src/lib/pilots/command.ts:runPilotCommand). All parsing, authorization,
 * invariants, and operator rendering live in tested `src/lib/pilots` code — this
 * file only bridges Slack ↔ that dispatcher. It never touches project creation
 * or Project Control.
 */

import { visualDevPilotEnabled } from '../../../src/lib/pilots/types'
import { defaultPilotDeps } from '../../../src/lib/pilots/defaults'
import { runPilotCommand } from '../../../src/lib/pilots/command'

/**
 * Handle `/kit pilot …`. `args` is everything after `pilot`. `ctx` carries the
 * resolved { workspaceId, slackUserId }. The `/kit` command already ack()ed.
 */
export async function handlePilotCommand(opts: {
  args: string
  channelId: string
  ctx: { workspaceId: string; slackUserId: string }
  respond: (msg: { response_type: 'ephemeral'; text: string }) => Promise<unknown>
}): Promise<void> {
  const { args, channelId, ctx, respond } = opts
  const { text } = await runPilotCommand(defaultPilotDeps(), {
    args,
    channelId,
    actor: { actingUserId: ctx.slackUserId, workspaceId: ctx.workspaceId },
    gateEnabled: visualDevPilotEnabled(),
  })
  await respond({ response_type: 'ephemeral', text })
}
