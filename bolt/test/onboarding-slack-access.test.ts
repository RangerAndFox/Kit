import { afterEach, describe, expect, it, vi } from 'vitest'
import { inviteArtistToSlack } from '../src/onboarding/services/slack'

const opts = { email: 'artist@example.com', fullName: 'Artist', projectChannelId: 'C1' }
function replies(...data: unknown[]) {
  const fetch = vi.fn()
  for (const value of data) fetch.mockResolvedValueOnce({ json: async () => value })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
afterEach(() => vi.unstubAllGlobals())
describe('Slack guest onboarding recovery', () => {
  it('verifies an existing guest without sending another invitation', async () => {
    const fetch = replies({ ok: true, user: { id: 'U1', is_restricted: true } }, { ok: true, members: ['U1'] })
    expect(await inviteArtistToSlack(opts)).toMatchObject({ status: 'ok', slackUserId: 'U1' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('conversations.invite'))).toBe(true)
  })
  it('preserves guest identity and provides an admin channel-only handoff', async () => {
    const fetch = replies({ ok: true, user: { id: 'U1', is_restricted: true } }, { ok: true, members: [] },
      { ok: false, error: 'user_is_restricted' }, { ok: true, members: [] })
    const result = await inviteArtistToSlack(opts)
    expect(result).toMatchObject({ status: 'failed', slackUserId: 'U1' })
    expect(result.message).toContain('Edit channels')
    expect(result.message).toContain('multi-channel')
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('conversations.invite'))).toHaveLength(1)
  })
  it('recognizes membership on later pages', async () => {
    replies({ ok: true, user: { id: 'U1' } }, { ok: true, members: ['U2'], response_metadata: { next_cursor: 'next' } },
      { ok: true, members: ['U1'] })
    expect((await inviteArtistToSlack(opts)).status).toBe('ok')
  })
  it('reconciles a failed invitation response without another write', async () => {
    const fetch = replies({ ok: true, user: { id: 'U1' } }, { ok: true, members: [] },
      { ok: false, error: 'internal_error' }, { ok: true, members: ['U1'] })
    expect((await inviteArtistToSlack(opts)).status).toBe('ok')
    expect(fetch).toHaveBeenCalledTimes(4)
  })
  it('does not confuse an unreadable membership list with permission to invite', async () => {
    const fetch = replies({ ok: true, user: { id: 'U1' } }, { ok: false, error: 'missing_scope' })
    expect(await inviteArtistToSlack(opts)).toMatchObject({ status: 'failed', slackUserId: 'U1' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('does not invite a new freelancer as a member or via Slack Connect', async () => {
    const fetch = replies({ ok: false, error: 'users_not_found' })
    const result = await inviteArtistToSlack(opts)
    expect(result.status).toBe('failed')
    expect(result.message).toContain('as a guest')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('does not reactivate deactivated accounts', async () => {
    const fetch = replies({ ok: true, user: { id: 'U1', deleted: true } })
    expect((await inviteArtistToSlack(opts)).status).toBe('failed')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('explains single-channel restrictions without upgrading the guest', async () => {
    replies({ ok: true, user: { id: 'U1', is_restricted: true, is_ultra_restricted: true } },
      { ok: true, members: [] }, { ok: false, error: 'ura_max_channels' }, { ok: true, members: [] })
    expect((await inviteArtistToSlack(opts)).message).toContain('admin-approved role change')
  })
})
