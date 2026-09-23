import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renamedDropboxIdentity } from '../../src/lib/dropbox/project-identity'
const mocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from }) }))
import { lookupDropboxProject } from '../src/watchers/dropbox'

beforeEach(() => vi.clearAllMocks())
describe('Dropbox rename identity', () => {
  it('preserves sibling metadata and all past names, deduplicating repeat renames', () => {
    const renamed = renamedDropboxIdentity({ project_number: '2638', dropbox_safe_name: 'old' }, 'new')
    expect(renamed).toEqual({ project_number: '2638', dropbox_safe_name: 'new', dropbox_safe_name_aliases: ['old'] })
    expect(renamedDropboxIdentity(renamed, 'new')).toEqual(renamed)
    expect(renamedDropboxIdentity(renamed, 'old').dropbox_safe_name_aliases).toEqual(['new'])
  })
  it('ignores malformed alias values', () => {
    expect(renamedDropboxIdentity({ dropbox_safe_name_aliases: [null, {}, 'prior', 'prior'] }, 'new').dropbox_safe_name_aliases).toEqual(['prior'])
  })
  function query(data: unknown, error: unknown = null) {
    const q = { select: vi.fn(), filter: vi.fn(), contains: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data, error }) }
    q.select.mockReturnValue(q); q.filter.mockReturnValue(q); q.contains.mockReturnValue(q)
    return q
  }
  it('prefers the current folder identity without consulting aliases', async () => {
    mocks.from.mockReturnValue(query({ id: 'existing' }))
    expect(await lookupDropboxProject('new')).toEqual({ id: 'existing' })
    expect(mocks.from).toHaveBeenCalledTimes(1)
  })
  it('routes queued old names to the same project without discovery or writes', async () => {
    const alias = query({ id: 'existing' })
    mocks.from.mockReturnValueOnce(query(null)).mockReturnValueOnce(alias)
    expect(await lookupDropboxProject('old')).toEqual({ id: 'existing' })
    expect(alias.contains).toHaveBeenCalledWith('external_ids', { dropbox_safe_name_aliases: ['old'] })
  })
  it('fails closed on unavailable or ambiguous alias results', async () => {
    mocks.from.mockReturnValueOnce(query(null)).mockReturnValueOnce(query(null, { message: 'multiple rows' }))
    await expect(lookupDropboxProject('old')).rejects.toThrow(/multiple rows/)
  })
})
