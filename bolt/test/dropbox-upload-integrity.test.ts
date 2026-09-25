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
let retiredRevision: string | null
let retirementReadError: boolean
let sourcePath: string
let successorRows: Array<{ id: string; payload: Record<string, unknown>; retired_at: string | null }> | null
let successorReadError: boolean
let currentProjectId: string | null
let currentProjectAliasOnly: boolean
const writes: Array<{ table: string; value: Record<string, unknown> }> = []
const queries: Array<{ table: string; filters: unknown[][] }> = []
function json(body: unknown) { return new Response(JSON.stringify(body)) }
beforeEach(() => {
  vi.clearAllMocks(); writes.length = 0; queries.length = 0
  vi.setSystemTime(new Date('2026-09-22T19:10:00Z'))
  vi.stubEnv('FRAMEIO_ACCOUNT_ID', 'account'); vi.stubGlobal('fetch', mocks.fetch)
  prior = { ...transfer }; sourceRev = delivery.rev; uploadComplete = true; leaseValid = true
  retiredRevision = null; retirementReadError = false
  sourcePath = delivery.path; successorRows = null; successorReadError = false; currentProjectId = 'project'
  currentProjectAliasOnly = false
  actualFile = { id: 'file', parent_id: 'folder', project_id: 'frame-project', file_size: 123, media_type: 'video/mp4', status: 'transcoding' }
  mocks.from.mockImplementation((table: string) => {
    let mutation = false
    const filters: unknown[][] = []; queries.push({ table, filters })
    const retirementQuery = () => filters.some(f => f[0] === 'not' && f[1] === 'retired_at')
    const projectResult = () => {
      const safeNameFilter = filters.find(f => f[0] === 'filter' && f[1] === 'external_ids->>dropbox_safe_name')
      if (currentProjectAliasOnly && safeNameFilter && safeNameFilter[3] !== delivery.safeName) return null
      const id = safeNameFilter?.[3] === delivery.safeName ? 'project' : currentProjectId
      return id ? { id, name: 'MRA', external_links: { frameio_id: 'frame-project' }, external_ids: {} } : null
    }
    const successors = () => (successorRows ?? [{ id: 'successor', retired_at: null, payload: {
      ...delivery, path: sourcePath, name: sourcePath.split('/01_Client Progress/')[1], rev: sourceRev,
    } }]).filter(row => filters.every(([op, key, value]) => {
      if (op === 'contains' && key === 'payload') return Object.entries(value as Record<string, unknown>).every(([k, v]) => row.payload[k] === v)
      if (op === 'is' && key === 'retired_at') return row.retired_at === value
      return true
    }))
    const result = () => ({ error: (retirementQuery() && retirementReadError) || (table === 'dropbox_event_inbox' && !mutation && successorReadError) ? { message: 'unavailable' } : null, data: mutation ? (leaseValid ? { ...transfer, id: table === 'dropbox_event_inbox' ? 'event' : 'transfer' } : null)
      : table === 'projects' ? projectResult()
        : table === 'frameio_delivery_transfers' ? retirementQuery()
          ? (retiredRevision && filters.some(f => f[0] === 'eq' && f[1] === 'dropbox_rev' && f[2] === retiredRevision) ? { id: 'retired' } : null)
          : prior : successors() })
    const query = {
      then: <T>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
      select: vi.fn(), eq: vi.fn(), neq: vi.fn(), is: vi.fn(), not: vi.fn(), filter: vi.fn(), contains: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn(), single: vi.fn(),
      update: vi.fn((value: Record<string, unknown>) => { mutation = true; writes.push({ table, value }); return query }),
      insert: vi.fn((value: Record<string, unknown>) => { mutation = true; writes.push({ table, value }); return query }),
    }
    for (const name of ['select', 'eq', 'neq', 'is', 'not', 'filter', 'contains', 'limit', 'maybeSingle', 'single'] as const) {
      query[name].mockImplementation((...args: unknown[]) => { filters.push([name, ...args]); return query })
    }
    return query
  })
  mocks.fetch.mockImplementation(async (url: string, options: RequestInit = {}) => {
    if (url === 'https://uc123.dl.dropboxusercontent.com/file' && options.method === 'GET') return new Response(new Uint8Array(123), { headers: { 'content-type': 'video/mp4', 'content-length': '123' } })
    const metadata = { '.tag': 'file', id: delivery.dropboxId, rev: sourceRev, size: 123, path_display: sourcePath, server_modified: '2026-09-22T19:00:00Z' }
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
  it('hands a renamed revision to its durable successor without uploading or notifying', async () => {
    prior = null; sourceRev = 'abcdef99999'; sourcePath = delivery.path.replace('video.mp4', 'renamed.mp4')
    mocks.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'claim_dropbox_events' ? [{ ...event }] : true }))
    expect(await drainDropboxInbox(app, { maxBatches: 1 })).toMatchObject({ completed: 1, deferred: 0, failed: 0 })
    expect(writes[0]).toMatchObject({ value: { payload: { automatic_resolution: { successor_event_id: 'successor' } } } })
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remote_upload'))).toBe(false)
    expect(mocks.message).not.toHaveBeenCalled()
    expect(queries.find(q => q.table === 'dropbox_event_inbox')?.filters).toContainEqual(['is', 'retired_at', null])
  })
  it('accepts a renamed project alias and a legacy successor without size evidence', async () => {
    prior = null; sourceRev = 'abcdef99999'; currentProjectAliasOnly = true
    sourcePath = delivery.path.replace(delivery.safeName, '2629_Microsoft_MRA_Renamed')
    const legacy: Record<string, unknown> = { ...delivery }
    delete legacy.sizeBytes
    successorRows = [{ id: 'successor', retired_at: null, payload: {
      ...legacy, rev: sourceRev, path: sourcePath, safeName: '2629_Microsoft_MRA_Renamed',
    } }]
    mocks.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'claim_dropbox_events' ? [{ ...event }] : true }))
    expect(await drainDropboxInbox(app, { maxBatches: 1 })).toMatchObject({ completed: 1, deferred: 0 })
    expect(queries.some(q => q.table === 'projects' && q.filters.some(f => f[0] === 'contains'))).toBe(true)
    expect(mocks.message).not.toHaveBeenCalled()
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remote_upload'))).toBe(false)
  })
  it.each(['missing', 'ambiguous', 'retired', 'moved out', 'wrong revision', 'stale path', 'cross project',
    'unknown project', 'wrong size', 'wrong route', 'missing current path', 'denied file'])('does not consume an unproven successor: %s', async (kind) => {
    prior = null; sourceRev = 'abcdef99999'
    const candidate = { id: 'successor', payload: { ...delivery, rev: sourceRev }, retired_at: null as string | null }
    successorRows = [candidate]
    if (kind === 'missing') successorRows = []
    if (kind === 'ambiguous') successorRows.push({ ...candidate, id: 'second' })
    if (kind === 'retired') candidate.retired_at = '2026-09-22T19:00:00Z'
    if (kind === 'moved out') sourcePath = delivery.path.replace('09_Outgoing/01_Client Progress', '07_AE')
    if (kind === 'wrong revision') candidate.payload.rev = 'other'
    if (kind === 'stale path') sourcePath = delivery.path.replace('video.mp4', 'elsewhere.mp4')
    if (kind === 'cross project' || kind === 'unknown project') {
      sourcePath = delivery.path.replace(delivery.safeName, '2636_Microsoft_CCAI')
      currentProjectId = kind === 'cross project' ? 'other-project' : null
      candidate.payload.path = sourcePath; candidate.payload.safeName = '2636_Microsoft_CCAI'
    }
    if (kind === 'wrong size') candidate.payload.sizeBytes = 456
    if (kind === 'wrong route') candidate.payload.subfolder = '02_Delivery'
    if (kind === 'missing current path') sourcePath = ''
    if (kind === 'denied file') {
      sourcePath = delivery.path.replace('video.mp4', 'audio.aac')
      candidate.payload.path = sourcePath; candidate.payload.name = 'audio.aac'
    }
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toBeInstanceOf(DropboxEventDeferred)
    expect(writes).toEqual([])
    expect(mocks.message).not.toHaveBeenCalled()
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remote_upload'))).toBe(false)
  })
  it('propagates successor lookup errors without completing or uploading', async () => {
    prior = null; sourceRev = 'abcdef99999'; successorReadError = true
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toMatchObject({ message: 'unavailable' })
    expect(writes).toEqual([])
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it('does not complete a superseded event after losing the audit checkpoint lease', async () => {
    prior = null; sourceRev = 'abcdef99999'; leaseValid = false
    mocks.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'claim_dropbox_events' ? [{ ...event }] : true }))
    await expect(drainDropboxInbox(app, { maxBatches: 1 })).rejects.toThrow(/audit checkpoint failed or lease lost/)
    expect(mocks.rpc).not.toHaveBeenCalledWith('complete_dropbox_event', expect.anything())
    expect(mocks.message).not.toHaveBeenCalled()
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remote_upload'))).toBe(false)
  })
  it('fences an exact retired revision before any provider call or notification', async () => {
    retiredRevision = delivery.rev
    mocks.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'claim_dropbox_events' ? [{ ...event }] : true }))
    expect(await drainDropboxInbox(app, { maxBatches: 1 })).toMatchObject({ completed: 0, failed: 0 })
    expect(writes[0]).toMatchObject({ table: 'dropbox_event_inbox', value: { retired_reason: 'Exact transfer revision was retired' } })
    expect(mocks.rpc).not.toHaveBeenCalledWith('complete_dropbox_event', expect.anything())
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it('keeps a later revision live and fails closed if the retirement lookup is unavailable', async () => {
    retiredRevision = 'old-revision'
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toBeInstanceOf(DropboxEventDeferred)
    mocks.fetch.mockClear(); retirementReadError = true
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toThrow(/retirement guard unavailable/)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
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
