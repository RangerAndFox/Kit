import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const mocks = vi.hoisted(() => ({ parse: vi.fn(), allowed: vi.fn(), from: vi.fn() }))
vi.mock('../src/llm/client', () => ({ anthropic: { messages: { create: mocks.parse } }, SPECIALIST_MODEL: 'test' }))
vi.mock('../src/onboarding/permissions', () => ({ canOnboard: mocks.allowed }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from }) }))
import { handleOnboardKeyword } from '../src/onboarding/keyword'
import { clearPendingOnboarding } from '../src/onboarding/state'
const post = vi.fn()
const info = vi.fn()
const app = { client: { users: { info }, chat: { postMessage: post } } } as unknown as App
beforeEach(() => {
  vi.resetAllMocks(); clearPendingOnboarding('D1', 'U1')
  mocks.allowed.mockResolvedValue(true)
  mocks.parse.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ isOnboardingIntent: true, artistName: null, artistEmail: null, projectQuery: '2636-microsoft-ccai' }) }] })
  info.mockResolvedValue({ ok: true, user: { id: 'U123ABC', real_name: 'Rachel DeMeyer', profile: { email: 'rachel@example.com' } } })
  const q = { select: vi.fn(), eq: vi.fn(), limit: vi.fn() }
  q.select.mockReturnValue(q); q.eq.mockReturnValue(q)
  q.limit.mockResolvedValue({ data: [{ id: 'p1', name: 'CCAI', client: 'Microsoft', project_code: '2636' }], error: null })
  mocks.from.mockReturnValue(q)
})
describe('existing artist onboarding conversation', () => {
  it('turns the reported mention and channel slug into an editable confirmation, without re-asking for email', async () => {
    await handleOnboardKeyword({ app, userId: 'U1', channelId: 'D1', text: 'onboard <@U123ABC> to 2636-microsoft-ccai' })
    const card = post.mock.calls[0][0]
    expect(card.text).toBe('Add Rachel DeMeyer to CCAI?')
    expect(card.blocks[1].elements.map((e: { text: { text: string } }) => e.text.text)).toEqual(['Add to project', 'Edit', 'Cancel'])
    expect(JSON.parse(card.blocks[1].elements[0].value)).toMatchObject({ p: 'p1', e: 'rachel@example.com' })
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith('projects')
  })
  it('denies an unauthorized actor before profile lookup or project access', async () => {
    mocks.allowed.mockResolvedValue(false)
    await handleOnboardKeyword({ app, userId: 'U1', channelId: 'D1', text: 'onboard <@U123ABC> to project 2636' })
    expect(info).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled()
    expect(post.mock.calls[0][0].text).toContain('restricted')
  })
  it('asks for email instead of guessing when Slack hides the profile email', async () => {
    info.mockResolvedValue({ ok: true, user: { id: 'U123ABC', real_name: 'Rachel DeMeyer' } })
    await handleOnboardKeyword({ app, userId: 'U1', channelId: 'D1', text: 'onboard <@U123ABC> to project 2636' })
    expect(post.mock.calls[0][0].text).toContain('artist email')
    expect(post.mock.calls[0][0].blocks).toBeUndefined()
  })
})
