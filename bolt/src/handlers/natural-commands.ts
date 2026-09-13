import { createHash, randomUUID } from 'node:crypto'
import type { App, BlockAction, ButtonAction, SlackActionMiddlewareArgs } from '@slack/bolt'
import type { WebClient, ChatPostMessageArguments } from '@slack/web-api'
import { createAdminClient } from '../../../src/lib/supabase/admin'
import { resolveUserContext, type UserContext } from '../../../src/lib/inngest/access-control'
import { KIT_COMMANDS, commandRequestSchema, parseFastCommand, type KitCommandName } from './command-catalog'
import { dispatchKitCommand, type CommandInvocation } from './command-dispatch'
import { saveCommandRequest, readCommandRequest, claimCommandRequest, finishCommandRequest, type CommandRecord } from './command-store'

export interface NaturalCommandContext {
  app: App
  userId: string
  teamId: string
  channelId: string
  threadTs?: string
  messageTs?: string
}

export async function handleNaturalCommandShortcut(context: NaturalCommandContext, text: string): Promise<boolean> {
  const request = parseFastCommand(text)
  if (!request) return false
  const summary = await offerNaturalCommand(context, request)
  if (context.channelId.startsWith('D')) {
    await context.app.client.chat.postMessage({ channel: context.channelId, thread_ts: context.threadTs, text: summary })
  } else {
    await context.app.client.chat.postEphemeral({ channel: context.channelId, thread_ts: context.threadTs, user: context.userId, text: summary })
  }
  return true
}

/** Resolve the actual bot team, never fall back to an arbitrary workspace. */
export async function commandActor(client: WebClient, userId: string, suppliedTeam: string): Promise<{ teamId: string; user: UserContext }> {
  const auth = await client.auth.test()
  const teamId = auth.team_id
  if (!auth.ok || !teamId || (suppliedTeam && suppliedTeam !== teamId)) throw new Error('Workspace identity could not be verified')
  const { data, error } = await createAdminClient().from('workspaces').select('id').eq('slack_team_id', teamId).maybeSingle()
  if (error || !data) throw new Error('Workspace is not connected to Kit')
  const user = await resolveUserContext(data.id, userId)
  if (!user) throw new Error('Your Kit role is not configured; ask an admin to add you')
  return { teamId, user }
}

export function canUseCommand(tier: UserContext['tier'], command: KitCommandName): boolean {
  const rank = { artist: 0, producer: 1, admin: 2 }
  return rank[tier] >= rank[KIT_COMMANDS[command].tier]
}

/** The LLM can only offer this card, never dispatch commands or select actors. */
export async function offerNaturalCommand(context: NaturalCommandContext, input: unknown): Promise<string> {
  const parsed = commandRequestSchema.safeParse(input)
  if (!parsed.success) return 'That command was not recognized. Please clarify the operation; nothing was run.'
  const { command, args } = parsed.data
  const { app, userId, channelId, threadTs } = context
  try {
    const { teamId, user } = await commandActor(app.client, userId, context.teamId)
    if (!canUseCommand(user.tier, command)) return 'That command is restricted to ' + KIT_COMMANDS[command].tier + ' access. Nothing was run.'
    const opened = await app.client.conversations.open({ users: userId })
    const dm = opened.channel?.id
    if (!opened.ok || !dm?.startsWith('D')) throw new Error('Private DM unavailable')
    const key = createHash('sha256').update([teamId, userId, channelId, context.messageTs || randomUUID()].join(':')).digest('hex')
    const record = await saveCommandRequest({ request_key: key, workspace_id: user.workspaceId, team_id: teamId, user_id: userId, source_channel: channelId, dm_channel: dm, thread_ts: channelId === dm ? threadTs : null, command, args })
    if (!record) return 'This request already has a private review card. No additional command was run.'
    const result = await app.client.chat.postMessage({
      channel: dm, ...(record.thread_ts ? { thread_ts: record.thread_ts } : {}),
      text: 'Review Kit request: ' + command,
      blocks: [
        { type: 'section', text: { type: 'plain_text', text: 'Review: ' + command + '\n' + KIT_COMMANDS[command].description + (args ? '\n\nDetails: ' + args : '') } },
        { type: 'context', elements: [{ type: 'plain_text', text: 'Nothing has run. Continue invokes the existing command/form with your current permissions. Review the details first. This card expires in 30 minutes.' }] },
        { type: 'actions', elements: [
          { type: 'button', action_id: 'kit_command_continue', style: 'primary', text: { type: 'plain_text', text: 'Continue' }, value: record.id },
          { type: 'button', action_id: 'kit_command_cancel', text: { type: 'plain_text', text: 'Cancel' }, value: record.id },
        ] },
      ], unfurl_links: false, unfurl_media: false,
    })
    if (!result.ok) throw new Error('Card delivery failed')
    return 'I sent the command review card to your private Kit DM. Review it and click Continue; nothing has run yet.'
  } catch {
    // No raw provider error or input values enter a shared reply/model context.
    return 'I could not safely open the private command card. Nothing was run. Please try again in your DM with Kit.'
  }
}

/** Keep ordinary command output private while retaining SOURCE channel context. */
export function privateCommandClient(client: WebClient, record: CommandRecord): WebClient {
  const chat = new Proxy(client.chat, { get(target, key) {
    if (key === 'postMessage') return (message: ChatPostMessageArguments) => client.chat.postMessage({ ...message, channel: record.dm_channel, reply_broadcast: false, thread_ts: record.thread_ts || undefined })
    return Reflect.get(target, key)
  } })
  return new Proxy(client, { get(target, key) { return key === 'chat' ? chat : Reflect.get(target, key) } })
}

export async function executeNaturalCommand(app: App, record: CommandRecord, triggerId: string): Promise<void> {
  const client = privateCommandClient(app.client, record)
  // Brain/pilot/note operate on a channel. All other form progress is private;
  // project pickers make the target explicit rather than inferring the wrong one.
  const sourceContext = ['brain', 'pilot', 'note'].includes(record.command)
  const command = {
    command: record.command === 'storyboard' ? '/storyboard' : '/kit',
    text: record.command === 'storyboard' ? record.args : record.command + (record.args ? ' ' + record.args : ''),
    user_id: record.user_id, team_id: record.team_id,
    channel_id: sourceContext ? record.source_channel : record.dm_channel,
    trigger_id: triggerId,
  } as CommandInvocation['command']
  await dispatchKitCommand(app, command.command as '/kit' | '/storyboard', {
    command, client, ack: async () => {},
    respond: async (message) => {
      const { response_type: _type, replace_original: _replace, delete_original: _delete, ...content } = typeof message === 'string' ? { text: message } : message
      // Response-URL controls do not apply to private Web API replies.
      void _type; void _replace; void _delete
      return await client.chat.postMessage({ ...content, text: content.text || 'Kit command response', channel: record.dm_channel, reply_broadcast: false, thread_ts: record.thread_ts || undefined })
    },
  })
}

export function registerNaturalCommandHandlers(app: App): void {
  const handle = (cancel: boolean) => async ({ ack, body, client }: SlackActionMiddlewareArgs<BlockAction<ButtonAction>> & { client: WebClient }) => {
    await ack()
    const actor = body.user?.id
    const dm = body.channel?.id
    const team = body.team?.id
    const id = body.actions?.[0]?.value
    if (!actor || !team || !dm?.startsWith('D') || !id || !/^[0-9a-f-]{36}$/i.test(id)) return
    const reply = (text: string) => client.chat.postEphemeral({ channel: dm, user: actor, text })
    let claimed: CommandRecord | null = null
    try {
      const record = await readCommandRequest(id, actor, team, dm)
      if (!record || record.status !== 'pending' || Date.parse(record.expires_at) <= Date.now()) {
        await reply('This card has expired or was already handled. Please send a new request if needed.')
        return
      }
      const { user } = await commandActor(client, actor, team)
      const parsed = commandRequestSchema.safeParse({ command: record.command, args: record.args })
      if (!parsed.success || user.workspaceId !== record.workspace_id || (!cancel && !canUseCommand(user.tier, record.command))) {
        await reply('Your current permissions do not allow this request. Nothing was run.')
        return
      }
      if (!cancel && !body.trigger_id) { await reply('Please click a fresh card to continue. Nothing was run.'); return }
      if (!await claimCommandRequest(record, cancel)) { await reply('This request was already handled. Nothing was run again.'); return }
      if (cancel) { await reply('Cancelled. Nothing was run.'); return }
      claimed = record
      await executeNaturalCommand(app, record, body.trigger_id)
      await finishCommandRequest(record.id, 'complete')
      // The canonical handler reports its own outcome; do not invent success.
    } catch {
      if (claimed) {
        try { await finishCommandRequest(claimed.id, 'review') } catch { /* stays running; never replay */ }
      }
      await reply(claimed ? 'Kit could not verify the final result. Check the command response before retrying; this card will not run twice.' : 'Kit could not verify this request. Nothing was run.')
    }
  }
  app.action('kit_command_continue', handle(false))
  app.action('kit_command_cancel', handle(true))
}
