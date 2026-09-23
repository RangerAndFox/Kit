import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn(), message: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }))
vi.mock('../../src/lib/dropbox/client', () => ({ dropboxHeaders: async () => ({}) }))
vi.mock('../../src/lib/frameio/auth', () => ({ frameioHeaders: async () => ({}) }))
vi.mock('../../src/lib/projects/settings', () => ({ isFrameioUploadEnabled: async () => true }))
import { drainDropboxInbox, DropboxEventDeferred, handleNewDelivery } from '../src/watchers/dropbox'

const delivery = { path: '/production/2026/2629_Microsoft_MRA/09_Outgoing/01_Client Progress/video.mp4',
  name: 'video.mp4', safeName: '2629_Microsoft_MRA', subfolder: '01_Client Progress', year: '2026',
  dropboxId: 'id:video', rev: 'abcdef12345', sizeBytes: 123 }
const event = { id: 'event', claim_token: 'lease', attempt_count: 1, created_at: '2026-09-22T19:00:00Z',
  event_key: 'key', event_type: 'frameio_delivery' as const, payload: { ...delivery } }
const app = { client: { chat: { postMessage: mocks.message } } } as unknown as App
const transfer = { id: 'transfer', state: 'processing', frameio_file_id: 'file', frameio_folder_id: 'folder',
  frameio_project_id: 'frame-project', frameio_status_path: '/accounts/account/files/file/status', created_at: '2026-09-22T19:00:00Z' }
let prior: typeof transfer | null
let sourceRev: string
let uploadComplete: boolean
let actualFile: Record<string, unknown>
let leaseValid: boolean
const writes: Array<{ table: string; value: Record<string, unknown> }> = []
const queries: Array<{ table: string; filters: unknown[][] }> = []
function json(body: unknown) { return new Response(JSON.stringify(body)) }
beforeEach(() => {
  vi.clearAllMocks(); writes.length = 0; queries.length = 0
  vi.setSystemTime(new Date('2026-09-22T19:10:00Z'))
  vi.stubEnv('FRAMEIO_ACCOUNT_ID', 'account'); vi.stubGlobal('fetch', mocks.fetch)
  prior = { ...transfer }; sourceRev = delivery.rev; uploadComplete = true; leaseValid = true
  actualFile = { id: 'file', parent_id: 'folder', project_id: 'frame-project', file_size: 123, media_type: 'video/mp4', status: 'transcoding' }
  mocks.from.mockImplementation((table: string) => {
    let mutation = false
    const filters: unknown[][] = []; queries.push({ table, filters })
    const result = () => ({ error: null, data: mutation ? (leaseValid ? { ...transfer, id: table === 'dropbox_event_inbox' ? 'event' : 'transfer' } : null)
      : table === 'projects' ? { id: 'project', name: 'MRA', external_links: { frameio_id: 'frame-project' }, external_ids: {} }
        : table === 'frameio_delivery_transfers' ? prior : [{ id: 'successor' }] })
    const query = {
      then: <T>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
      select: vi.fn(), eq: vi.fn(), neq: vi.fn(), filter: vi.fn(), contains: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn(), single: vi.fn(),
      update: vi.fn((value: Record<string, unknown>) => { mutation = true; writes.push({ table, value }); return query }),
      insert: vi.fn((value: Record<string, unknown>) => { mutation = true; writes.push({ table, value }); return query }),
    }
    for (const name of ['select', 'eq', 'neq', 'filter', 'contains', 'limit', 'maybeSingle', 'single'] as const) {
      query[name].mockImplementation((...args: unknown[]) => { filters.push([name, ...args]); return query })
    }
    return query
  })
  mocks.fetch.mockImplementation(async (url: string, options: RequestInit = {}) => {
    if (url === 'https://uc123.dl.dropboxusercontent.com/file' && options.method === 'GET') return new Response(new Uint8Array(123), { headers: { 'content-type': 'video/mp4', 'content-length': '123' } })
    const metadata = { id: delivery.dropboxId, rev: sourceRev, size: 123, server_modified: '2026-09-22T19:00:00Z' }
    if (url.endsWith('/files/get_metadata')) return json(metadata)
    if (url.endsWith('/files/get_temporary_link')) return json({ metadata, link: 'https://uc123.dl.dropboxusercontent.com/file' })
    if (url.endsWith('/projects/frame-project')) return json({ data: { root_folder_id: 'root' } })
    if (url.endsWith('/folders/root/children')) return json({ data: [{ id: 'out', name: '03_Outgoing', type: 'folder' }] })
    if (url.endsWith('/folders/out/children')) return json({ data: [{ id: 'folder', name: '01_Client Progress', type: 'folder' }] })
    if (url.endsWith('/remote_upload')) return json({ data: { id: 'file' }, links: { status: transfer.frameio_status_path } })
    if (url.endsWith('/status')) return json({ data: { upload_complete: uploadComplete, upload_failed: false } })
    if (url.endsWith('/files/file')) return json({ data: actualFile })
    throw new Error(`Unexpected provider effect: ${url}`)
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('upload pipeline integrity boundary', () => {
  it('never creates shares or sends messages for the observed empty JSON placeholder', async () => {
    actualFile = { ...actualFile, file_size: 0, media_type: 'application/json', status: 'transcoded' }
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toThrow(/file size/)
    expect(writes.some(w => w.value.state === 'ready')).toBe(false)
    expect(writes.some(w => w.value.state === 'failed')).toBe(true)
    expect(mocks.from).not.toHaveBeenCalledWith('frameio_folder_shares')
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it('defers completed transfers until transcoding finishes, without announcing', async () => {
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toBeInstanceOf(DropboxEventDeferred)
    expect(writes.some(w => w.value.state === 'ready')).toBe(false)
    expect(mocks.from).not.toHaveBeenCalledWith('frameio_folder_shares')
  })
  it('revalidates a previously-ready transfer on retry', async () => {
    prior = { ...transfer, state: 'ready' }; actualFile = { ...actualFile, media_type: 'application/json' }
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toThrow(/media type/)
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it('pins the download revision and checkpoints source evidence before remote upload', async () => {
    prior = null; uploadComplete = false
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toBeInstanceOf(DropboxEventDeferred)
    const call = mocks.fetch.mock.calls.find(([url]) => url.endsWith('/get_temporary_link'))
    expect(JSON.parse(call?.[1].body)).toEqual({ path: `rev:${delivery.rev}` })
    expect(writes[0]).toMatchObject({ table: 'dropbox_event_inbox', value: { payload: { sizeBytes: 123 } } })
    expect(queries.find(q => q.table === 'dropbox_event_inbox')?.filters).toContainEqual(['eq', 'claim_token', 'lease'])
  })
  it('never starts an upload after losing the source checkpoint lease', async () => {
    prior = null; leaseValid = false
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toThrow(/lease lost/)
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remote_upload'))).toBe(false)
  })
  it('completes a superseded pre-upload event with a fenced audit and no provider effects', async () => {
    prior = null; sourceRev = 'abcdef99999'
    mocks.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'claim_dropbox_events' ? [{ ...event }] : true }))
    expect(await drainDropboxInbox(app, { maxBatches: 1 })).toMatchObject({ completed: 1, failed: 0 })
    expect(writes[0]).toMatchObject({ table: 'dropbox_event_inbox', value: { payload: {
      automatic_resolution: { outcome: 'superseded_before_upload', successor_event_id: 'successor' },
    } } })
    expect(mocks.rpc).toHaveBeenCalledWith('complete_dropbox_event', { p_event_id: 'event', p_claim_token: 'lease' })
    expect(mocks.fetch.mock.calls.some(([, options]) => options.method === 'POST' && String(options.body).includes('source_url'))).toBe(false)
    expect(mocks.message).not.toHaveBeenCalled()
  })
})
