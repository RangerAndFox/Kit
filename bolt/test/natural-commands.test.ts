import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
const { resolveUser, db, save, read, claim, finish, dispatch } = vi.hoisted(() => ({ resolveUser: vi.fn(), db: vi.fn(), save: vi.fn(), read: vi.fn(), claim: vi.fn(), finish: vi.fn(), dispatch: vi.fn() }))
vi.mock('../../src/lib/inngest/access-control', () => ({ resolveUserContext: resolveUser }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: db }))
vi.mock('../src/handlers/command-store', () => ({ saveCommandRequest: save, readCommandRequest: read, claimCommandRequest: claim, finishCommandRequest: finish }))
vi.mock('../src/handlers/command-dispatch', () => ({ dispatchKitCommand: dispatch }))
import { offerNaturalCommand, registerNaturalCommandHandlers, executeNaturalCommand, canUseCommand, commandActor, handleGuidanceFollowup } from '../src/handlers/natural-commands'
import { rememberGuidanceInvitation, pendingGuidance } from '../src/handlers/guidance-followup'
import { resetMemoryForTest } from '../src/llm/memory'
import { KIT_COMMANDS } from '../src/handlers/command-catalog'
import type { CommandRecord } from '../src/handlers/command-store'

const record: CommandRecord = { id: '11111111-1111-4111-8111-111111111111', request_key: 'key', workspace_id: 'w1', team_id: 'T1', user_id: 'U1', source_channel: 'C_SHARED', dm_channel: 'D_ACTOR', command: 'help', args: '', status: 'pending', expires_at: '2099-01-01T00:00:00Z' }
const client = { auth: { test: vi.fn() }, conversations: { open: vi.fn(), replies: vi.fn() }, chat: { postMessage: vi.fn(), postEphemeral: vi.fn() } }
let actions: Map<string, (args: Record<string, unknown>) => Promise<void>>
let app: App
beforeEach(() => {
  vi.resetAllMocks()
  resetMemoryForTest()
  actions = new Map()
  app = { client, action: (name: string, handler: (args: Record<string, unknown>) => Promise<void>) => actions.set(name, handler) } as unknown as App
  registerNaturalCommandHandlers(app)
  client.auth.test.mockResolvedValue({ ok: true, team_id: 'T1' })
  client.conversations.open.mockResolvedValue({ ok: true, channel: { id: 'D_ACTOR' } })
  client.conversations.replies.mockResolvedValue({ ok: true, messages: [], has_more: false })
  client.chat.postMessage.mockResolvedValue({ ok: true, ts: '5.0' })
  client.chat.postEphemeral.mockResolvedValue({ ok: true })
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'w1' } }) }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  db.mockReturnValue({ from: vi.fn(() => query) })
  resolveUser.mockResolvedValue({ workspaceId: 'w1', slackUserId: 'U1', tier: 'admin' })
  save.mockImplementation(async input => ({ ...record, ...input }))
  read.mockResolvedValue(record)
  claim.mockResolvedValue(true)
  finish.mockResolvedValue(undefined)
  dispatch.mockResolvedValue(undefined)
})
const context = () => ({ app, userId: 'U1', teamId: 'T1', channelId: 'C_SHARED', threadTs: '1.0', messageTs: '2.0' })
async function click(action = 'kit_command_continue', changes: Record<string, unknown> = {}) {
  await actions.get(action)!({ ack: vi.fn(), client, body: { user: { id: 'U1' }, team: { id: 'T1' }, channel: { id: 'D_ACTOR' }, trigger_id: 'fresh-click', actions: [{ value: record.id }], ...changes } })
}

describe('private natural command confirmations', () => {
  it('a guidance start button only creates a private review card under the real clicker identity', async () => {
    await click('kit_guidance_start', { channel: { id: 'C_SHARED' }, message: { ts: '3.0', thread_ts: '1.0' }, actions: [{ value: 'onboard' }] })
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ command: 'onboard', args: '', user_id: 'U1', team_id: 'T1', source_channel: 'C_SHARED', dm_channel: 'D_ACTOR' }))
    expect(dispatch).not.toHaveBeenCalled()
    expect(client.chat.postMessage.mock.calls[0][0].channel).toBe('D_ACTOR')
  })
  it('guidance dismissal, unknown names and role revocation cannot start a workflow', async () => {
    await click('kit_guidance_dismiss', { message: { ts: '3.0' }, actions: [{ value: 'onboard' }] })
    await click('kit_guidance_start', { message: { ts: '3.0' }, actions: [{ value: '__proto__' }] })
    resolveUser.mockResolvedValue({ workspaceId: 'w1', tier: 'artist' })
    await click('kit_guidance_start', { message: { ts: '3.0' }, actions: [{ value: 'onboard' }] })
    expect(save).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('a threaded yes uses the offered command and never dispatches it', async () => {
    rememberGuidanceInvitation(context(), 'onboard')
    expect(await handleGuidanceFollowup(context(), 'yes please')).toBe(true)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ command: 'onboard', args: '' }))
    expect(pendingGuidance(context())).toBeNull()
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('a threaded no consumes the invitation without creating any review request', async () => {
    rememberGuidanceInvitation(context(), 'onboard')
    expect(await handleGuidanceFollowup(context(), 'not now')).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('an expired/lost guidance context cannot fall through to an unrelated time confirmation', async () => {
    client.conversations.replies.mockResolvedValue({ ok: true, messages: [{ blocks: [{ type: 'actions', elements: [{ action_id: 'kit_guidance_start', value: 'onboard' }] }] }] })
    expect(await handleGuidanceFollowup(context(), 'yes')).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(JSON.stringify(client.chat.postEphemeral.mock.calls)).toContain('no longer awaiting')
  })
  it('fails closed on an unreadable or truncated confirmation thread, without breaking verified hours threads', async () => {
    client.conversations.replies.mockRejectedValueOnce(new Error('outage'))
    expect(await handleGuidanceFollowup(context(), 'yes')).toBe(true)
    client.conversations.replies.mockResolvedValueOnce({ ok: true, messages: [], has_more: true })
    expect(await handleGuidanceFollowup(context(), 'yes')).toBe(true)
    expect(await handleGuidanceFollowup(context(), 'yes')).toBe(false)
    expect(save).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
  it.each(Object.keys(KIT_COMMANDS))('can offer %s but never executes from a message', async command => {
    await offerNaturalCommand(context(), { command, args: '' })
    expect(save).toHaveBeenCalledOnce()
    expect(client.chat.postMessage).toHaveBeenCalledOnce()
    expect(client.chat.postMessage.mock.calls[0][0].channel).toBe('D_ACTOR')
    expect(client.chat.postMessage.mock.calls[0][0].thread_ts).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('keeps input private and stores only server-side arguments, not in button values', async () => {
    const summary = await offerNaturalCommand(context(), { command: 'note', args: '9999 | Budget $99,000; client@example.com' })
    expect(summary).not.toMatch(/99,000|client@example/)
    const message = client.chat.postMessage.mock.calls[0][0]
    expect(message.blocks[2].elements.map((button: { value: string }) => button.value)).toEqual([record.id, record.id])
    expect(save.mock.calls[0][0].thread_ts).toBeNull()
  })
  it('preserves a verified private thread', async () => {
    await offerNaturalCommand({ ...context(), channelId: 'D_ACTOR' }, { command: 'help', args: '' })
    expect(client.chat.postMessage.mock.calls[0][0].thread_ts).toBe('1.0')
  })
  it.each(['delete', 'role', 'dashboard', 'brain', 'onboard', 'workers'])('denies artists before offering %s', async command => {
    resolveUser.mockResolvedValue({ workspaceId: 'w1', tier: 'artist' })
    expect(await offerNaturalCommand(context(), { command, args: '' })).toContain('restricted')
    expect(save).not.toHaveBeenCalled()
    expect(client.chat.postMessage).not.toHaveBeenCalled()
  })
  it('fails closed if workspace resolution or DM routing cannot be verified', async () => {
    await expect(commandActor(client as unknown as WebClient, 'U1', 'T_OTHER')).rejects.toThrow()
    client.conversations.open.mockResolvedValue({ ok: true, channel: { id: 'G_SHARED' } })
    expect(await offerNaturalCommand(context(), { command: 'help', args: '' })).toContain('Nothing was run')
    expect(save).not.toHaveBeenCalled()
  })
  it('does not issue another card for a duplicate message event', async () => {
    save.mockResolvedValue(null)
    expect(await offerNaturalCommand(context(), { command: 'help', args: '' })).toContain('already')
    expect(client.chat.postMessage).not.toHaveBeenCalled()
  })
  it('does not claim card delivery succeeded on a Slack rejection', async () => {
    client.chat.postMessage.mockResolvedValue({ ok: false })
    expect(await offerNaturalCommand(context(), { command: 'help', args: '' })).toContain('could not safely')
  })
  it('uses the original actor/team/DM binding, not button-supplied arguments', async () => {
    await click()
    expect(read).toHaveBeenCalledWith(record.id, 'U1', 'T1', 'D_ACTOR')
    expect(dispatch).toHaveBeenCalledOnce()
    const invocation = dispatch.mock.calls[0][2]
    expect(invocation.command).toMatchObject({ user_id: 'U1', team_id: 'T1', channel_id: 'D_ACTOR', trigger_id: 'fresh-click', text: 'help' })
    expect(finish).toHaveBeenCalledWith(record.id, 'complete')
  })
  it('rejects another actor and cards clicked in a channel', async () => {
    read.mockResolvedValue(null)
    await click('kit_command_continue', { user: { id: 'U_OTHER' } })
    await click('kit_command_continue', { channel: { id: 'C_SHARED' } })
    expect(claim).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
  it.each([{ ...record, status: 'complete' }, { ...record, expires_at: '2000-01-01' }])('rejects an expired or handled card', async stale => {
    read.mockResolvedValue(stale)
    await click()
    expect(claim).not.toHaveBeenCalled()
  })
  it('rechecks permissions if someone loses their role before clicking', async () => {
    read.mockResolvedValue({ ...record, command: 'delete', args: 'project' })
    resolveUser.mockResolvedValue({ workspaceId: 'w1', tier: 'artist' })
    await click()
    expect(claim).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('lets only the winning atomic claim execute concurrent clicks', async () => {
    claim.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await Promise.all([click(), click()])
    expect(dispatch).toHaveBeenCalledOnce()
  })
  it('cancels without invoking any command', async () => {
    await click('kit_command_cancel')
    expect(claim).toHaveBeenCalledWith(record, true)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('requires a real fresh trigger before claiming', async () => {
    await click('kit_command_continue', { trigger_id: undefined })
    expect(claim).not.toHaveBeenCalled()
  })
  it('does not automatically replay an uncertain result', async () => {
    dispatch.mockRejectedValue(new Error('uncertain external write'))
    await click()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledWith(record.id, 'review')
    expect(JSON.stringify(client.chat.postEphemeral.mock.calls)).not.toContain('uncertain external write')
  })
  it('retains source context for notes while redirecting output privately', async () => {
    await executeNaturalCommand(app, { ...record, command: 'note', args: '9999 | approved' }, 'fresh')
    const invocation = dispatch.mock.calls[0][2]
    expect(invocation.command.channel_id).toBe('C_SHARED')
    await invocation.client.chat.postMessage({ channel: 'C_SHARED', text: 'private details' })
    await invocation.respond({ response_type: 'in_channel', text: 'also private' })
    expect(client.chat.postMessage.mock.calls.every(call => call[0].channel === 'D_ACTOR')).toBe(true)
  })
  it('still enters the existing typed-confirmation deletion flow', async () => {
    await executeNaturalCommand(app, { ...record, command: 'delete', args: 'project' }, 'fresh')
    expect(dispatch).toHaveBeenCalledWith(app, '/kit', expect.objectContaining({ command: expect.objectContaining({ text: 'delete project' }) }))
  })
  it('keeps the conservative tier matrix explicit', () => {
    expect(canUseCommand('artist', 'help')).toBe(true)
    expect(canUseCommand('artist', 'status')).toBe(true)
    expect(canUseCommand('producer', 'delete')).toBe(false)
    expect(canUseCommand('producer', 'brain')).toBe(true)
  })
})
