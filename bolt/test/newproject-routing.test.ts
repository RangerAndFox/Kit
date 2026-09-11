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
  it.each([undefined, 'group', 'mpim', 'im'])('takes creation ahead of hours or LLM for channel type %s', async (channelType) => {
    const app = { client: {} } as unknown as App
    await handleConversationalMessage({ app, channelId: 'C_SOURCE', userId: 'U_PRODUCER', teamId: 'T1', messageText: 'new project', messageTs: '2.0', threadTs: '1.0', assistantThreadTs: '1.0', channelType, isDirectMention: true })
    expect(sendIntake).toHaveBeenCalledWith({ client: app.client, userId: 'U_PRODUCER', channelId: 'C_SOURCE', threadTs: '1.0' })
    expect(findCheckin).not.toHaveBeenCalled()
    expect(parseCheckin).not.toHaveBeenCalled()
    expect(confirmCheckin).not.toHaveBeenCalled()
    expect(orchestrate).not.toHaveBeenCalled()
  })
  it('handles the actual app_mention callback in a shared thread', async () => {
    type Mention = { event: { channel: string; user: string; team: string; text: string; ts: string; thread_ts: string } }
    const events = new Map<string, (args: Mention) => Promise<void>>()
    const app = { client: {}, event: (name: string, handler: (args: Mention) => Promise<void>) => events.set(name, handler) } as unknown as App
    registerMessageHandlers(app)
    await events.get('app_mention')!({ event: { channel: 'C_SHARED', user: 'U_PRODUCER', team: 'T1', text: '<@UKIT> new project', ts: '2.0', thread_ts: '1.0' } })
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
  it('uses the same intake from the Assistant/plain-DM shortcut registry', async () => {
    const handled = await handleDmShortcut({ client: {} } as unknown as App, { channelId: 'D_PRODUCER', userId: 'U_PRODUCER', teamId: 'T1', text: 'new project\nSent using <@UCHATGPT>', threadTs: '1.0' })
    expect(handled).toBe(true)
    expect(sendIntake).toHaveBeenCalledOnce()
    expect(orchestrate).not.toHaveBeenCalled()
  })
})
