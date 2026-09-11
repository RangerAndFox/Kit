import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { permission } = vi.hoisted(() => ({ permission: vi.fn() }))
vi.mock('../src/onboarding/permissions', () => ({ canOnboard: permission }))
import { isNewProjectTrigger, resolvePrivateProjectIntake, sendNewProjectIntake } from '../src/handlers/newproject-intake'

const client = {
  conversations: { open: vi.fn() },
  chat: { postMessage: vi.fn(), postEphemeral: vi.fn() },
  users: { info: vi.fn() },
}
const slackClient = client as unknown as Parameters<typeof sendNewProjectIntake>[0]['client']
beforeEach(() => {
  vi.resetAllMocks()
  permission.mockResolvedValue(true)
  client.users.info.mockResolvedValue({ ok: true, user: { profile: { email: 'producer@example.com' } } })
  client.conversations.open.mockResolvedValue({ ok: true, channel: { id: 'D_ACTOR' } })
  client.chat.postMessage.mockResolvedValue({ ok: true })
  client.chat.postEphemeral.mockResolvedValue({ ok: true })
})

describe('canonical project intake', () => {
  it.each(['new project', 'newproject', '/newproject', '/new project', '/kit newproject', 'Please create a new project', 'Can you please set up project 9999 for Acme?', '<@UKIT> new project', 'new project\nProject ID: 9999\nClient: Acme\nProject Name: Example Sizzle\nBudget: 10K', '1. 9999\n2. Acme\n3. Example Sizzle\n4. 10K'])('recognizes creation intent: %s', (text) => {
    expect(isNewProjectTrigger(text)).toBe(true)
  })
  it.each(['4 hours on the new project yesterday', 'tell me about a new project', 'new storyboard', 'create a storyboard', 'create the project tabs in this channel', 'new project updates', '1. 4h on 9999\n2. 3h on 9998', ''])('does not steal other work: %s', (text) => {
    expect(isNewProjectTrigger(text)).toBe(false)
  })
  it.each(['C_PUBLIC', 'G_PRIVATE', 'G_MPIM'])('moves %s requests privately without echoing input', async (channelId) => {
    await sendNewProjectIntake({ client: slackClient, userId: 'U_ACTOR', channelId, threadTs: '123.1' })
    expect(client.conversations.open).toHaveBeenCalledWith({ users: 'U_ACTOR' })
    const post = client.chat.postMessage.mock.calls[0][0]
    expect(post.channel).toBe('D_ACTOR')
    expect(post.thread_ts).toBeUndefined()
    expect(JSON.stringify(post.blocks)).toContain('kit_open_newproject_modal')
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ channel: channelId, user: 'U_ACTOR', thread_ts: '123.1' }))
    expect(JSON.stringify(client.chat.postEphemeral.mock.calls)).not.toMatch(/10K|Acme/)
  })
  it('keeps an existing verified DM thread', async () => {
    await sendNewProjectIntake({ client: slackClient, userId: 'U_ACTOR', channelId: 'D_ACTOR', threadTs: '123.1' })
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'D_ACTOR', thread_ts: '123.1' }))
    expect(client.chat.postEphemeral).not.toHaveBeenCalled()
  })
  it('denies artists before opening intake', async () => {
    permission.mockResolvedValue(false)
    await sendNewProjectIntake({ client: slackClient, userId: 'U_ARTIST', channelId: 'C_PUBLIC' })
    expect(client.conversations.open).not.toHaveBeenCalled()
    expect(client.chat.postMessage).not.toHaveBeenCalled()
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Only producers and admins') }))
  })
  it.each([{ ok: false }, { ok: true, channel: { id: 'G_SHARED' } }])('fails closed when DM resolution fails: %j', async (response) => {
    client.conversations.open.mockResolvedValue(response)
    await sendNewProjectIntake({ client: slackClient, userId: 'U_ACTOR', channelId: 'C_PUBLIC' })
    expect(client.chat.postMessage).not.toHaveBeenCalled()
    expect(client.chat.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('No project was created') }))
  })
  it('does not trust another DM or old shared-card metadata', async () => {
    expect(await resolvePrivateProjectIntake(slackClient, 'U_ACTOR', 'D_OTHER', '123.1')).toEqual({ channelId: 'D_ACTOR', threadTs: undefined })
  })
  it('routes mentions before hours and never treats channel threads as DMs', () => {
    const messages = readFileSync(join(__dirname, '../src/handlers/messages.ts'), 'utf8')
    const shared = messages.slice(messages.indexOf('export async function handleConversationalMessage'))
    expect(shared.indexOf('await sendNewProjectIntake')).toBeLessThan(shared.indexOf('await findOpenCheckin'))
    expect(messages).not.toContain("channelType === 'im' || assistantThreadTs")
    expect(messages).toContain("if (channelType === 'im' && looksLikeHoursIntent(messageText))")
  })
  it('uses private routing for slash commands, old cards and modal submissions', () => {
    const commands = readFileSync(join(__dirname, '../src/handlers/commands.ts'), 'utf8')
    expect(commands).toContain('await sendNewProjectIntake({ client, userId: command.user_id')
    const interactions = readFileSync(join(__dirname, '../src/handlers/interactions.ts'), 'utf8')
    const open = interactions.slice(interactions.indexOf("app.action('kit_open_newproject_modal'"), interactions.indexOf("app.action('kit_cancel_newproject'"))
    expect(open).toContain('await resolvePrivateProjectIntake(client, actor')
    const submit = interactions.slice(interactions.indexOf("app.view('kit_provision_project'"))
    expect(submit.indexOf('await resolvePrivateProjectIntake(client, userId')).toBeLessThan(submit.indexOf('await runProjectProvisioning'))
  })
})
