import { afterEach, describe, expect, it, vi } from 'vitest'
import { inviteArtistToSlack } from './slack'

const guest = { id: 'U1', team_id: 'T1', is_restricted: true, is_ultra_restricted: false }
const input = { email: 'artist@example.com', fullName: 'Artist', projectChannelId: 'C1' }
afterEach(() => vi.unstubAllGlobals())

function mock(responses: unknown[]) {
  const calls: { method: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ method: new URL(String(url)).pathname.slice(5), body: init?.body ? JSON.parse(init.body) : undefined })
    if (!responses.length) throw new Error('Unexpected Slack request')
    return { json: async () => responses.shift() }
  }))
  return calls
}

describe('guest-only Slack onboarding', () => {
  it('requires admin invitation for new users without any write', async () => {
    const calls = mock([{ ok: false, error: 'users_not_found' }])
    expect(await inviteArtistToSlack(input)).toMatchObject({ status: 'failed', message: expect.stringContaining('single-channel guest') })
    expect(calls).toHaveLength(1)
  })
  it.each([
    { ...guest, is_restricted: false },
    { ...guest, is_restricted: undefined },
    { ...guest, team_id: 'EXTERNAL' },
    { ...guest, deleted: true },
    { ...guest, is_admin: true },
    { ...guest, is_invited_user: true },
    { ...guest, is_ultra_restricted: undefined },
  ])('rejects non-guest or unsafe identities without writing: %j', async (user) => {
    const calls = mock([{ ok: true, user }, { ok: true, team_id: 'T1' }])
    expect((await inviteArtistToSlack(input)).status).toBe('failed')
    expect(calls.every(c => !c.body)).toBe(true)
  })
  it('does not move a single-channel guest to another project', async () => {
    const calls = mock([{ ok: true, user: { ...guest, is_ultra_restricted: true } }, { ok: true, team_id: 'T1' }, { ok: true, members: [] }])
    expect((await inviteArtistToSlack(input)).status).toBe('failed')
    expect(calls.every(c => !c.body)).toBe(true)
  })
  it('verifies an existing single-channel guest without re-inviting', async () => {
    const user = { ...guest, is_ultra_restricted: true }
    const calls = mock([{ ok: true, user }, { ok: true, team_id: 'T1' }, { ok: true, members: ['U1'] }, { ok: true, user }, { ok: true, members: ['U1'] }])
    expect(await inviteArtistToSlack(input)).toMatchObject({ status: 'ok', slackUserId: 'U1' })
    expect(calls.every(c => !c.body)).toBe(true)
  })
  it('adds a multi-channel guest only to the specified channel, then verifies', async () => {
    const calls = mock([{ ok: true, user: guest }, { ok: true, team_id: 'T1' }, { ok: true, members: [], response_metadata: { next_cursor: 'next' } }, { ok: true, members: [] }, { ok: true }, { ok: true, user: guest }, { ok: true, members: ['U1'] }])
    expect((await inviteArtistToSlack(input)).status).toBe('ok')
    expect(calls.filter(c => c.body)).toEqual([{ method: 'conversations.invite', body: { channel: 'C1', users: 'U1' } }])
  })
  it('never reports success when the post-invite role is a full member', async () => {
    mock([{ ok: true, user: guest }, { ok: true, team_id: 'T1' }, { ok: true, members: [] }, { ok: true }, { ok: true, user: { ...guest, is_restricted: false } }])
    expect((await inviteArtistToSlack(input)).status).toBe('failed')
  })
  it('never reports success when post-invite membership is absent', async () => {
    mock([{ ok: true, user: guest }, { ok: true, team_id: 'T1' }, { ok: true, members: [] }, { ok: true }, { ok: true, user: guest }, { ok: true, members: [] }])
    expect((await inviteArtistToSlack(input)).status).toBe('failed')
  })
  it('fails closed on lookup outage rather than issuing another invite', async () => {
    const calls = mock([{ ok: false, error: 'ratelimited' }])
    expect((await inviteArtistToSlack(input)).status).toBe('failed')
    expect(calls).toHaveLength(1)
  })
})
