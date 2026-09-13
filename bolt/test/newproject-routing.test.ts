import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const { sendIntake, findCheckin, parseCheckin, confirmCheckin, orchestrate } = vi.hoisted(() => ({
  sendIntake: vi.fn(), findCheckin: vi.fn(), parseCheckin: vi.fn(), confirmCheckin: vi.fn(), orchestrate: vi.fn(),
}))
vi.mock('../src/handlers/newproject-intake', async () => ({
  ...await vi.importActual('../src/handlers/newproject-intake'), sendNewProjectIntake: sendIntake,
}))
vi.mock('../src/checkins/reply', () => ({ findOpenCheckin: findCheckin, handleCheckinReply: parseCheckin, handleParsedCheckinText: confirmCheckin }))
vi.mock('../src/llm/orchestrator', () => ({ runOrchestrator: orchestrate }))
import { handleConversationalMessage, handleDmShortcut, registerMessageHandlers } from '../src/handlers/messages'

beforeEach(() => {
  vi.clearAllMocks()
  sendIntake.mockResolvedValue(undefined)
  findCheckin.mockResolvedValue({ id: 'open-checkin', status: 'sent' })
})

describe('new-project incident routing regression', () => {
  it.each([undefined, 'group', 'mpim', 'im'].flatMap(channelType => [
    'new project', 'Kit make a new project', 'We need a new project for Acme', 'Can you make us a new project?',
  ].map(messageText => ({ channelType, messageText }))))('takes "$messageText" ahead of hours or LLM for channel type $channelType', async ({ channelType, messageText }) => {
    const app = { client: {} } as unknown as App
    await handleConversationalMessage({ app, channelId: 'C_SOURCE', userId: 'U_PRODUCER', teamId: 'T1', messageText, messageTs: '2.0', threadTs: '1.0', assistantThreadTs: '1.0', channelType, isDirectMention: true })
    expect(sendIntake).toHaveBeenCalledWith({ client: app.client, userId: 'U_PRODUCER', channelId: 'C_SOURCE', threadTs: '1.0' })
    expect(findCheckin).not.toHaveBeenCalled()
    expect(parseCheckin).not.toHaveBeenCalled()
    expect(confirmCheckin).not.toHaveBeenCalled()
    expect(orchestrate).not.toHaveBeenCalled()
  })
  it.each(['<@UKIT> new project', '<@UKIT>, make a new project', 'Hey <@UKIT>, could you make us a new project for Acme?'])('handles the actual app_mention callback in a shared thread: %s', async (text) => {
    type Mention = { event: { channel: string; user: string; team: string; text: string; ts: string; thread_ts: string } }
    const events = new Map<string, (args: Mention) => Promise<void>>()
    const app = { client: {}, event: (name: string, handler: (args: Mention) => Promise<void>) => events.set(name, handler) } as unknown as App
    registerMessageHandlers(app)
    await events.get('app_mention')!({ event: { channel: 'C_SHARED', user: 'U_PRODUCER', team: 'T1', text, ts: '2.0', thread_ts: '1.0' } })
    expect(sendIntake).toHaveBeenCalledOnce()
    expect(sendIntake).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'C_SHARED', userId: 'U_PRODUCER' }))
    expect(findCheckin).not.toHaveBeenCalled()
    expect(orchestrate).not.toHaveBeenCalled()
  })
  it('intercepts the old numbered follow-up instead of turning project fields into hours', async () => {
    await handleConversationalMessage({ app: { client: {} } as unknown as App, channelId: 'D_PRODUCER', userId: 'U_PRODUCER', teamId: 'T1', messageText: '1. 9999\n2. Acme\n3. Example Sizzle\n4. 10K', messageTs: '2.0', threadTs: '1.0', assistantThreadTs: '1.0', channelType: 'im', isDirectMention: false })
    expect(sendIntake).toHaveBeenCalledOnce()
    expect(findCheckin).not.toHaveBeenCalled()
    expect(orchestrate).not.toHaveBeenCalled()
  })
  it.each(['new project', 'Kit make a new project', 'Can you please make us a new project for Acme?'])('uses the same intake from the Assistant/plain-DM shortcut registry: %s', async (text) => {
    const handled = await handleDmShortcut({ client: {} } as unknown as App, { channelId: 'D_PRODUCER', userId: 'U_PRODUCER', teamId: 'T1', text: `${text}\nSent using <@UCHATGPT>`, threadTs: '1.0' })
    expect(handled).toBe(true)
    expect(sendIntake).toHaveBeenCalledOnce()
    expect(orchestrate).not.toHaveBeenCalled()
  })
  it.each(['Kit, do not create a new project', 'Create a new project schedule', '4 hours on the new project yesterday'])('does not open a card from unrelated DM text: %s', async (text) => {
    expect(await handleDmShortcut({ client: {} } as unknown as App, { channelId: 'D_PRODUCER', userId: 'U_PRODUCER', teamId: 'T1', text })).toBe(false)
    expect(sendIntake).not.toHaveBeenCalled()
  })
  it('leaves a real hours reply in the check-in workflow', async () => {
    parseCheckin.mockResolvedValueOnce(true)
    await handleConversationalMessage({ app: { client: {} } as unknown as App, channelId: 'D_PRODUCER', userId: 'U_PRODUCER', teamId: 'T1', messageText: '4 hours on the new project yesterday', messageTs: '2.0', threadTs: '1.0', channelType: 'im', isDirectMention: false })
    expect(parseCheckin).toHaveBeenCalledOnce()
    expect(sendIntake).not.toHaveBeenCalled()
    expect(orchestrate).not.toHaveBeenCalled()
  })
})
