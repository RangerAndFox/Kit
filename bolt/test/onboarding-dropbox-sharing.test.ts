import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/lib/dropbox/client', () => ({ dropboxHeaders: async () => ({ Authorization: 'Bearer test' }) }))
import { inviteArtistToDropbox } from '../src/onboarding/services/dropbox'

const project = { id: 'project', name: 'Project', external_links: { dropbox_id: '/production/2026/project' } }
const opts = { project, artistEmail: 'artist@example.com' }
function responses(...values: unknown[]) {
  const fetch = vi.fn()
  for (const value of values) fetch.mockResolvedValueOnce({ ok: true, json: async () => value })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe('onboarding Dropbox project sharing', () => {
  it('uses the nested project share ID, never re-shares or grants the parent', async () => {
    const fetch = responses({ '.tag': 'folder', sharing_info: { shared_folder_id: 'project-share', parent_shared_folder_id: 'studio-share' } }, {})
    expect(await inviteArtistToDropbox(opts)).toMatchObject({ status: 'ok', externalId: 'project-share' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.dropboxapi.com/2/files/get_metadata', 'https://api.dropboxapi.com/2/sharing/add_folder_member',
    ])
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ shared_folder_id: 'project-share', members: [{ member: { email: opts.artistEmail } }] })
  })
  it('retains compatibility with the legacy top-level share ID', async () => {
    responses({ shared_folder_id: 'legacy-share' }, {})
    expect(await inviteArtistToDropbox(opts)).toMatchObject({ status: 'ok', externalId: 'legacy-share' })
  })
  it('does not treat inherited parent membership as a project share', async () => {
    const fetch = responses({ sharing_info: { parent_shared_folder_id: 'studio-share' } }, { '.tag': 'complete', shared_folder_id: 'new-project-share' }, {})
    expect(await inviteArtistToDropbox(opts)).toMatchObject({ status: 'ok', externalId: 'new-project-share' })
    expect(JSON.parse(fetch.mock.calls[2][1].body).shared_folder_id).toBe('new-project-share')
  })
  it('surfaces a failed share job without inviting the artist or repeatedly polling', async () => {
    vi.useFakeTimers()
    const fetch = responses({}, { '.tag': 'async_job_id', async_job_id: 'job' }, { '.tag': 'failed', failed: { '.tag': 'access_error' } })
    const pending = inviteArtistToDropbox(opts)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({ status: 'failed', message: expect.stringContaining('No artist invitation was sent') })
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
