import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const { db, resolveUser, findCheckin, parseCheckin, confirmCheckin, onboard, newProject, role, toggle, note, frame, adhoc } = vi.hoisted(() => ({
  db: vi.fn(), resolveUser: vi.fn(), findCheckin: vi.fn(), parseCheckin: vi.fn(), confirmCheckin: vi.fn(), onboard: vi.fn(), newProject: vi.fn(), role: vi.fn(), toggle: vi.fn(), note: vi.fn(), frame: vi.fn(), adhoc: vi.fn(),
}))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: db }))
vi.mock('../../src/lib/inngest/access-control', () => ({ resolveUserContext: resolveUser }))
vi.mock('../src/checkins/reply', () => ({ findOpenCheckin: findCheckin, handleCheckinReply: parseCheckin, handleParsedCheckinText: confirmCheckin }))
vi.mock('../src/onboarding/keyword', () => ({ isOnboardTrigger: () => true, handleOnboardKeyword: onboard }))
vi.mock('../src/onboarding/state', () => ({ getPendingOnboarding: () => ({ pending: true }) }))
vi.mock('../src/handlers/newproject-intake', async () => ({ ...await vi.importActual('../src/handlers/newproject-intake'), sendNewProjectIntake: newProject }))
vi.mock('../src/roles/handler', () => ({ handleRoleMessage: role }))
vi.mock('../src/delivery/frameio-toggle', () => ({ handleFrameioToggleMessage: toggle }))
vi.mock('../src/notes/handler', () => ({ handleNoteMessage: note }))
vi.mock('../../src/lib/frameio/slack-handler', () => ({ messageHasFrameIoLink: () => true, handleFrameIoLink: frame }))
vi.mock('../src/checkins/adhoc', () => ({ looksLikeHoursIntent: () => true, handleAdhocHoursEntry: adhoc }))
import { handleConversationalMessage, handleDmShortcut } from '../src/handlers/messages'
import { pendingGuidance, rememberGuidanceClarification } from '../src/handlers/guidance-followup'
import { resetMemoryForTest } from '../src/llm/memory'

beforeEach(() => {
  vi.clearAllMocks()
  resetMemoryForTest()
  resolveUser.mockResolvedValue({ workspaceId: 'w1', name: 'Test Producer', tier: 'producer', slackUserId: 'U1' })
  db.mockReturnValue({ from: (table: string) => {
    const query = { select: vi.fn(), eq: vi.fn(), limit: vi.fn(), or: vi.fn(), single: vi.fn(), maybeSingle: vi.fn(), upsert: vi.fn() }
    for (const method of ['select', 'eq', 'limit', 'or'] as const) query[method].mockReturnValue(query)
    query.single.mockResolvedValue({ data: table === 'workspaces' ? { id: 'w1' } : null })
    query.maybeSingle.mockResolvedValue({ data: table === 'workspaces' ? { id: 'w1' } : null })
    query.upsert.mockResolvedValue({ error: null })
    return query
  } })
})

describe('guidance before legacy action/hour interceptors', () => {
  it('treats the answer to “which function?” as guidance, not a new onboarding action', async () => {
    rememberGuidanceClarification({ teamId: 'T_GUIDANCE', channelId: 'D1', userId: 'U1', threadTs: '1.0' })
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '3.0' })
    const app = { client: { chat: { postMessage }, users: { info: vi.fn().mockResolvedValue({ user: { profile: {} } }) }, assistant: { threads: { setStatus: vi.fn() } } } } as unknown as App
    expect(await handleDmShortcut(app, { channelId: 'D1', userId: 'U1', teamId: 'T_GUIDANCE', text: 'onboard', threadTs: '1.0' })).toBe(false)
    await handleConversationalMessage({ app, channelId: 'D1', userId: 'U1', teamId: 'T_GUIDANCE', messageText: 'onboard', messageTs: '2.0', threadTs: '1.0', assistantThreadTs: '1.0', channelType: 'im', isDirectMention: false })
    expect(postMessage.mock.calls[0][0].text).toContain('Want me to open the onboarding setup now?')
    expect(onboard).not.toHaveBeenCalled()
    expect(findCheckin).not.toHaveBeenCalled()
  })
  it.each(['How do I onboard an artist?', 'Walk me through creating a new project', 'How do I add a project note?', 'Explain how SRT conversion works'])('keeps %s read-only even with a pending intake and matching legacy parsers', async messageText => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: '3.0' })
    const app = { client: { chat: { postMessage }, users: { info: vi.fn().mockResolvedValue({ user: { profile: {} } }) }, assistant: { threads: { setStatus: vi.fn() } } } } as unknown as App
    const context = { app, channelId: 'D1', userId: 'U1', teamId: 'T_GUIDANCE', messageText, messageTs: '2.0', threadTs: '1.0', assistantThreadTs: '1.0', channelType: 'im', isDirectMention: false }
    expect(await handleDmShortcut(app, { channelId: 'D1', userId: 'U1', teamId: 'T_GUIDANCE', text: messageText, threadTs: '1.0' })).toBe(false)
    await handleConversationalMessage(context)
    for (const handler of [findCheckin, parseCheckin, confirmCheckin, onboard, newProject, role, toggle, note, frame, adhoc]) expect(handler).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledOnce()
    expect(postMessage.mock.calls[0][0]).toMatchObject({ channel: 'D1', thread_ts: '1.0' })
    expect(postMessage.mock.calls[0][0].text).toMatch(/\*.+\*[\s\S]*1\. /)
    if (messageText.includes('onboard')) expect(pendingGuidance({ teamId: 'T_GUIDANCE', channelId: 'D1', userId: 'U1', threadTs: '1.0' })).toBe('onboard')
  })
  it('does not arm a follow-up when Slack did not deliver the guide', async () => {
    const app = { client: { chat: { postMessage: vi.fn().mockResolvedValue({ ok: false }) }, users: { info: vi.fn().mockResolvedValue({ user: { profile: {} } }) }, assistant: { threads: { setStatus: vi.fn() } } } } as unknown as App
    await handleConversationalMessage({ app, channelId: 'D1', userId: 'U1', teamId: 'T_GUIDANCE', messageText: 'How do I onboard an artist?', messageTs: '2.0', threadTs: '1.0', assistantThreadTs: '1.0', channelType: 'im', isDirectMention: false })
    expect(pendingGuidance({ teamId: 'T_GUIDANCE', channelId: 'D1', userId: 'U1', threadTs: '1.0' })).toBeNull()
  })
})
