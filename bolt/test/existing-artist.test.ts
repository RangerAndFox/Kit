import { describe, expect, it, vi } from 'vitest'
import type { WebClient } from '@slack/web-api'
import { resolveExistingArtist } from '../src/onboarding/existing-artist'
import { parseFastCommand } from '../src/handlers/command-catalog'
import { canUseCommand } from '../src/handlers/natural-commands'

const rachel = { id: 'U123ABC', real_name: 'Rachel DeMeyer', profile: { email: 'rachel@example.com' } }
function client(members = [rachel]) {
  return { users: { info: vi.fn().mockResolvedValue({ ok: true, user: rachel }), list: vi.fn().mockResolvedValue({ ok: true, members }) } }
}
describe('existing artist project access', () => {
  it.each(['<@U123ABC>', '@U123ABC'])('resolves %s without asking for email', async mention => {
    const c = client()
    expect(await resolveExistingArtist(c as unknown as WebClient, `add ${mention} to 2636-microsoft-ccai`, null, null))
      .toEqual({ kind: 'matched', name: 'Rachel DeMeyer', email: 'rachel@example.com' })
    expect(c.users.list).not.toHaveBeenCalled()
  })
  it('resolves a unique first name', async () => {
    expect(await resolveExistingArtist(client() as unknown as WebClient, 'add Rachel to project 2636', 'Rachel', null)).toMatchObject({ kind: 'matched' })
  })
  it('does not choose between matching people', async () => {
    const c = client([rachel, { ...rachel, id: 'U456DEF', real_name: 'Rachel Other' }])
    expect(await resolveExistingArtist(c as unknown as WebClient, '', 'Rachel', null)).toEqual({ kind: 'ambiguous' })
  })
  it('does not accept a conflicting email alongside a mention', async () => {
    expect(await resolveExistingArtist(client() as unknown as WebClient, '<@U123ABC>', null, 'other@example.com')).toEqual({ kind: 'conflict' })
  })
  it('fails closed when the directory cannot be completely read', async () => {
    const c = client(); c.users.list.mockResolvedValue({ ok: true, members: [rachel], response_metadata: { next_cursor: 'more' } })
    expect(await resolveExistingArtist(c as unknown as WebClient, '', 'Rachel', null)).toEqual({ kind: 'unavailable' })
  })
  it('does not use disabled users or unavailable profiles', async () => {
    const c = client(); c.users.info.mockResolvedValue({ ok: true, user: { ...rachel, deleted: true } })
    expect(await resolveExistingArtist(c as unknown as WebClient, '<@U123ABC>', null, null)).toEqual({ kind: 'unmatched' })
    c.users.info.mockRejectedValue(new Error('missing_scope'))
    expect(await resolveExistingArtist(c as unknown as WebClient, '<@U123ABC>', null, null)).toEqual({ kind: 'unavailable' })
  })
  it.each(['add <@U123ABC> to 2636-microsoft-ccai', 'add Rachel to project 2642', 'assign Rachel to project 2636'])('routes %s to onboarding rather than role changes', text => {
    expect(parseFastCommand(text)?.command).toBe('onboard')
  })
  it('keeps role changes admin-only, while allowing producers to add artists', () => {
    expect(canUseCommand('producer', 'onboard')).toBe(true)
    expect(canUseCommand('artist', 'onboard')).toBe(false)
    expect(canUseCommand('producer', 'role')).toBe(false)
  })
  it.each(['do not add Rachel to project 2636', 'how do I add Rachel to project 2636'])('does not offer execution for %s', text => {
    expect(parseFastCommand(text)).toBeNull()
  })
})
