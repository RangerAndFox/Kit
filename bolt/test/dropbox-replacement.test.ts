import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ from: vi.fn(), fetch: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from }) }))
vi.mock('../../src/lib/dropbox/client', () => ({ dropboxHeaders: async () => ({}) }))
vi.mock('../../src/lib/frameio/auth', () => ({ frameioHeaders: async () => ({}) }))
import { findVerifiedReplacement } from '../src/watchers/dropbox'

const old = { id: 'old', project_id: 'project', frameio_project_id: 'frame-project',
  frameio_folder_id: 'folder', frameio_file_id: 'old-file', created_at: '2026-09-21T15:08:54Z', state: 'processing' }
const replacement = { ...old, id: 'new', frameio_file_id: 'new-file', state: 'ready', created_at: '2026-09-21T16:10:47Z' }
const event = { id: 'old-event', event_type: 'frameio_delivery', event_key: 'key', claim_token: 'lease', attempt_count: 1,
  payload: { path: '/project/09_Outgoing/cut.mp4', dropboxId: 'id:old', rev: 'old-rev' } }
const missing = new Error('Frame.io upload status is not visible yet (404); exceeded 24-hour processing window')
let rows: unknown[]
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }) }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('FRAMEIO_ACCOUNT_ID', 'account')
  vi.stubGlobal('fetch', mocks.fetch)
  rows = [old, [{ id: 'replacement-event' }], replacement]
  mocks.from.mockImplementation(() => {
    const result = { data: rows.shift(), error: null }
    const query = {
      then: <T>(resolve: (value: typeof result) => T) => Promise.resolve(result).then(resolve),
      select: vi.fn(), eq: vi.fn(), contains: vi.fn(), gt: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn(),
    }
    for (const name of ['select', 'eq', 'contains', 'gt', 'limit', 'maybeSingle'] as const) query[name].mockReturnValue(query)
    return query
  })
  mocks.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    if (url.includes('get_metadata')) return JSON.parse(String(options.body)).path === 'id:old'
      ? response({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }, 409)
      : response({ id: 'id:new', rev: 'new-rev', size: 123 })
    if (url.endsWith('/old-file')) return response({ errors: [{ detail: 'Entity with ID old-file not found.' }] }, 404)
    return response({ data: { id: 'new-file', parent_id: 'folder', status: 'transcoded', file_size: 123 } })
  })
})

describe('replacement recovery provider checks', () => {
  it('returns audit evidence without uploads, notifications, or database mutations', async () => {
    expect(await findVerifiedReplacement(event, missing)).toMatchObject({
      outcome: 'superseded_by_verified_replacement', replacement_event_id: 'replacement-event',
      replacement_transfer_id: 'new', replacement_frameio_file_id: 'new-file', previous_error: missing.message,
    })
    expect(mocks.fetch).toHaveBeenCalledTimes(4)
    for (const [url, options] of mocks.fetch.mock.calls) {
      expect(url).not.toMatch(/remote_upload|shares|slack/)
      if (options.method === 'POST') expect(url).toContain('/files/get_metadata')
    }
    const query = mocks.from.mock.results[1].value
    expect(query.contains).toHaveBeenCalledWith('payload', { path: event.payload.path, dropboxId: 'id:new', rev: 'new-rev' })
    expect(query.eq).toHaveBeenCalledWith('status', 'complete')
  })
  it('ignores unrelated errors without any provider calls', async () => {
    expect(await findVerifiedReplacement(event, new Error('upload failed'))).toBeNull()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('does not run replacement checks during normal eventual consistency', async () => {
    expect(await findVerifiedReplacement(event, new Error('Frame.io upload status is not visible yet (404); inbox will retry'))).toBeNull()
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it.each([[], [{ id: 'one' }, { id: 'two' }]])('rejects missing or ambiguous completed events', async (events) => {
    rows[1] = events
    expect(await findVerifiedReplacement(event, missing)).toBeNull()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })
  it('does not mistake Dropbox authorization failure for source deletion', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ id: 'id:new', rev: 'new-rev', size: 123 }))
      .mockResolvedValueOnce(response({ error: 'denied' }, 403))
    await expect(findVerifiedReplacement(event, missing)).rejects.toThrow(/metadata check failed/)
  })
  it('does not mistake a Frame.io routing 404 for deletion', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ id: 'id:new', rev: 'new-rev', size: 123 }))
      .mockResolvedValueOnce(response({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }, 409))
      .mockResolvedValueOnce(response({ errors: [{ detail: 'no route found for GET /v4/v4' }] }, 404))
    expect(await findVerifiedReplacement(event, missing)).toBeNull()
  })
  it('does not retire an event while the original Dropbox source still exists', async () => {
    mocks.fetch.mockResolvedValueOnce(response({ id: 'id:new', rev: 'new-rev', size: 123 }))
      .mockResolvedValueOnce(response({ id: 'id:old', rev: 'old-rev' }))
    expect(await findVerifiedReplacement(event, missing)).toBeNull()
  })
})
