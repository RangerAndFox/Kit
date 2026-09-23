import { afterEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ assign: vi.fn(), single: vi.fn() }))
vi.mock('../../src/lib/harvest/client', () => ({ assignUserToProject: mock.assign }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mock.single }) }) }) }) }))
import { inviteArtistToHarvest } from '../src/onboarding/services/harvest'
import { getPaperwork } from '../src/onboarding/nda/paperwork'

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
describe('onboarding setup safety', () => {
  const project = { id: 'p', name: 'Test', client: null, project_code: null, brief_summary: null, target_delivery: null, external_ids: {}, external_links: { harvest_id: '123' } }
  for (const id of ['', '0', '-4', 'Infinity', '1.5', 'bad']) {
    it(`does not assign an absent or invalid Harvest bucket (${id || 'unset'})`, async () => {
      vi.stubEnv('HARVEST_FREELANCER_USER_ID', id)
      expect((await inviteArtistToHarvest({ project, artistEmail: 'artist@example.com', artistName: 'Artist' })).status).toBe('skipped')
      expect(mock.assign).not.toHaveBeenCalled()
    })
  }
  it('assigns only the configured existing Harvest user', async () => {
    vi.stubEnv('HARVEST_FREELANCER_USER_ID', '456')
    mock.assign.mockResolvedValue({})
    expect((await inviteArtistToHarvest({ project, artistEmail: 'artist@example.com', artistName: 'Artist' })).status).toBe('ok')
    expect(mock.assign).toHaveBeenCalledExactlyOnceWith({ projectId: 123, userId: 456 })
  })
  it('does not treat an unreadable NDA ledger as no paperwork on file', async () => {
    mock.single.mockResolvedValue({ data: null, error: { message: 'unavailable' } })
    await expect(getPaperwork('artist@example.com')).rejects.toThrow('before sending another NDA')
  })
  it('returns null only for a successful empty paperwork lookup', async () => {
    mock.single.mockResolvedValue({ data: null, error: null })
    expect(await getPaperwork('artist@example.com')).toBeNull()
  })
})
