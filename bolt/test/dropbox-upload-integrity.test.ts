import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), fetch: vi.fn(), message: vi.fn(), createApproval: vi.fn(), getApproval: vi.fn(), updateApproval: vi.fn(), claimPost: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }))
vi.mock('../../src/lib/dropbox/client', () => ({ dropboxHeaders: async () => ({}) }))
vi.mock('../../src/lib/frameio/auth', () => ({ frameioHeaders: async () => ({}) }))
vi.mock('../../src/lib/projects/settings', () => ({ isFrameioUploadEnabled: async () => true }))
vi.mock('../../src/lib/delivery/upload-approval-store', () => ({
  uploadApprovalsEnabled: () => process.env.FRAMEIO_UPLOAD_APPROVALS_ENABLED === 'true',
  createUploadApproval: mocks.createApproval, getUploadApproval: mocks.getApproval,
  updateUploadApproval: mocks.updateApproval, claimUploadPost: mocks.claimPost,
  assertUploadReviewer: async () => {},
}))
import { drainDropboxInbox, DropboxEventDeferred, handleNewDelivery } from '../src/watchers/dropbox'

const delivery = { path: '/production/2026/2629_Microsoft_MRA/09_Outgoing/01_Client Progress/video.mp4',
  name: 'video.mp4', safeName: '2629_Microsoft_MRA', subfolder: '01_Client Progress', year: '2026',
  dropboxId: 'id:video', rev: 'abcdef12345', sizeBytes: 256 }
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
let sourceBytes: Buffer
let changeAfterInspection: boolean
let sourceMissing: boolean
let replacementId: string
const writes: Array<{ table: string; value: Record<string, unknown> }> = []
const queries: Array<{ table: string; filters: unknown[][] }> = []
function json(body: unknown) { return new Response(JSON.stringify(body)) }
beforeEach(() => {
  vi.clearAllMocks(); writes.length = 0; queries.length = 0
  mocks.rpc.mockResolvedValue({ data: true, error: null })
  vi.setSystemTime(new Date('2026-09-22T19:10:00Z'))
  vi.stubEnv('FRAMEIO_ACCOUNT_ID', 'account'); vi.stubGlobal('fetch', mocks.fetch)
  prior = { ...transfer }; sourceRev = delivery.rev; uploadComplete = true; leaseValid = true
  retiredRevision = null; retirementReadError = false
  sourcePath = delivery.path; successorRows = null; successorReadError = false; currentProjectId = 'project'
  currentProjectAliasOnly = false
  sourceBytes = Buffer.alloc(256)
  sourceBytes.writeUInt32BE(128); sourceBytes.write('moov', 4)
  sourceBytes.writeUInt32BE(108, 8); sourceBytes.write('mvhd', 12)
  sourceBytes.writeUInt32BE(1000, 28); sourceBytes.writeUInt32BE(1000, 32)
  sourceBytes.writeUInt32BE(12, 116); sourceBytes.write('trak', 120)
  sourceBytes.writeUInt32BE(128, 128); sourceBytes.write('mdat', 132)
  changeAfterInspection = false
  sourceMissing = false; replacementId = delivery.dropboxId
  actualFile = { id: 'file', parent_id: 'folder', project_id: 'frame-project', file_size: 256, media_type: 'video/mp4', status: 'transcoding' }
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
    if (url === 'https://uc123.dl.dropboxusercontent.com/file' && options.method === 'GET') {
      if (changeAfterInspection) sourceRev = 'abcdef99999'
      return new Response(sourceBytes, { headers: { 'content-type': 'video/mp4', 'content-length': '256' } })
    }
    const metadata = { '.tag': 'file', id: replacementId, rev: sourceRev, size: 256, path_display: sourcePath, server_modified: '2026-09-22T19:00:00Z' }
    if (url.endsWith('/files/get_metadata')) {
      if (sourceMissing && JSON.parse(String(options.body)).path === delivery.dropboxId) {
        return new Response(JSON.stringify({ error: { '.tag': 'path', path: { '.tag': 'not_found' } } }), { status: 409 })
      }
      return json(metadata)
    }
    if (url.endsWith('/files/get_temporary_link')) return json({ metadata, link: 'https://uc123.dl.dropboxusercontent.com/file' })
    if (url.endsWith('/files/move_v2')) {
      sourcePath = JSON.parse(String(options.body)).to_path
      return json({ metadata: {...metadata,path_display:sourcePath} })
    }
    if (url.endsWith('/projects/frame-project')) return json({ data: { root_folder_id: 'root' } })
    if (url.includes('/folders/root/children')) return json({ data: [{ id: 'out', name: '03_Outgoing', type: 'folder' }] })
    if (url.includes('/folders/out/children')) return json({ data: [{ id: 'folder', name: '01_Client Progress', type: 'folder' }] })
    if (url.includes('/folders/folder/children')) return json({ data: [] })
    if (url.endsWith('/remote_upload')) return json({ data: { id: 'file' }, links: { status: transfer.frameio_status_path } })
    if (url.endsWith('/status')) return json({ data: { upload_complete: uploadComplete, upload_failed: false } })
    if (url.endsWith('/files/file')) return json({ data: actualFile })
    throw new Error(`Unexpected provider effect: ${url}`)
  })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('upload pipeline integrity boundary', () => {
  it('requires human review before creating folders, renaming, uploading or announcing', async () => {
    prior = null; vi.stubEnv('FRAMEIO_UPLOAD_APPROVALS_ENABLED','true')
    await handleNewDelivery(app,{...delivery},{...event})
    expect(mocks.createApproval).toHaveBeenCalledWith('project',delivery,256)
    expect(mocks.fetch.mock.calls.some(([url]) => url.includes('api.frame.io'))).toBe(false)
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/files/move_v2'))).toBe(false)
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it('does not ask to approve an unfinished render or a superseded revision', async () => {
    prior = null; vi.stubEnv('FRAMEIO_UPLOAD_APPROVALS_ENABLED','true')
    sourceRev = 'new-revision'
    await expect(handleNewDelivery(app,{...delivery},{...event})).rejects.toThrow(/durable successor/)
    expect(mocks.createApproval).not.toHaveBeenCalled()
    sourceRev = delivery.rev; sourceBytes.fill(0)
    await expect(handleNewDelivery(app,{...delivery},{...event})).rejects.toThrow(/render not finalized/)
    expect(mocks.createApproval).not.toHaveBeenCalled()
    expect(mocks.fetch.mock.calls.some(([url]) => url.includes('api.frame.io'))).toBe(false)
  })
  it.each(['skipped','superseded','complete','collision'])('never executes a %s approval', async state => {
    prior = null
    mocks.getApproval.mockResolvedValue({project_id:'project',source_file_id:delivery.dropboxId,source_rev:delivery.rev,approval_version:1,state})
    await handleNewDelivery(app,{...delivery,approvalRequestId:'request',approvalVersion:1},{...event})
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('quarantines an ambiguous POST receipt instead of repeating the upload', async () => {
    prior = null
    mocks.getApproval.mockResolvedValue({id:'request',project_id:'project',source_file_id:delivery.dropboxId,source_rev:delivery.rev,approval_version:1,state:'uploading',upload_attempted_at:'2026-09-22'})
    await handleNewDelivery(app,{...delivery,approvalRequestId:'request',approvalVersion:1},{...event})
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.updateApproval).toHaveBeenCalledWith('request',expect.objectContaining({state:'needs_review'}))
  })
  it('keeps already accepted transfers resumable during approval rollout', async () => {
    vi.stubEnv('FRAMEIO_UPLOAD_APPROVALS_ENABLED','true')
    await expect(handleNewDelivery(app,{...delivery},{...event})).rejects.toThrow(/still transcoding/)
    expect(mocks.createApproval).not.toHaveBeenCalled()
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remote_upload'))).toBe(false)
  })
  it.each(['file','version_stack'])('holds replacement for review if the new %s version is not the displayed head', async conflictType => {
    actualFile.status = 'transcoded'
    mocks.getApproval.mockResolvedValue({ id:'request',project_id:'project',source_file_id:delivery.dropboxId,source_rev:delivery.rev,
      source_size:256,source_path:delivery.path,approved_name:'video.mp4',decision:'replace',approval_version:1,state:'uploading',
      conflict_id: conflictType === 'file' ? 'old-file' : 'stack', conflict_type:conflictType })
    const originalFetch = mocks.fetch.getMockImplementation()!
    mocks.fetch.mockImplementation((url:string, options:RequestInit = {}) => {
      if (url.endsWith('/version_stacks') || url.endsWith('/files/file/move')) {
        actualFile.parent_id = 'stack'
        return Promise.resolve(json({data:{id:'stack'}}))
      }
      if (url.endsWith('/version_stacks/stack')) return Promise.resolve(json({data:{head_version:{id:'old-file'}}}))
      return originalFetch(url,options)
    })
    await expect(handleNewDelivery(app,{...delivery,approvalRequestId:'request',approvalVersion:1},{...event}))
      .rejects.toThrow(/not the displayed latest version/)
    expect(mocks.updateApproval).toHaveBeenCalledWith('request',expect.objectContaining({state:'needs_review'}))
    expect(mocks.updateApproval).not.toHaveBeenCalledWith('request',expect.objectContaining({version_stack_id:'stack'}))
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it('renames only an approved exact revision and checkpoints the upload before processing', async () => {
    prior = null; mocks.claimPost.mockResolvedValue(true)
    mocks.getApproval.mockResolvedValue({id:'request',project_id:'project',source_file_id:delivery.dropboxId,source_rev:delivery.rev,
      source_size:256,source_path:delivery.path,approved_name:'R&F_Microsoft_MRA_Edit_V2.mp4',decision:'new',approval_version:1,state:'approved'})
    await expect(handleNewDelivery(app,{...delivery,approvalRequestId:'request',approvalVersion:1},{...event})).rejects.toThrow(/still transcoding/)
    const move = mocks.fetch.mock.calls.find(([url])=>url.endsWith('/files/move_v2'))
    expect(JSON.parse(String(move?.[1].body))).toMatchObject({from_path:delivery.dropboxId,autorename:false,to_path:delivery.path.replace('video.mp4','R&F_Microsoft_MRA_Edit_V2.mp4')})
    expect(mocks.claimPost).toHaveBeenCalledOnce()
    expect(mocks.fetch.mock.calls.filter(([url])=>url.endsWith('/remote_upload'))).toHaveLength(1)
    expect(mocks.updateApproval).toHaveBeenCalledWith('request',{frame_file_id:'file'})
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it('pauses for the same approver if a same-name Frame file exists after confirmation', async () => {
    prior = null
    mocks.getApproval.mockResolvedValue({id:'request',project_id:'project',source_file_id:delivery.dropboxId,source_rev:delivery.rev,
      source_size:256,source_path:delivery.path,approved_name:'R&F_Microsoft_MRA_Edit_V2.mp4',decision:'new',approval_version:1,state:'approved'})
    const originalFetch = mocks.fetch.getMockImplementation()!
    mocks.fetch.mockImplementation((url:string,options:RequestInit)=>url.includes('/folders/folder/children')
      ? Promise.resolve(json({data:[{id:'someone-elses-file',name:'R&F_Microsoft_MRA_Edit_V2.mp4',type:'file'}]})) : originalFetch(url,options))
    expect(await handleNewDelivery(app,{...delivery,approvalRequestId:'request',approvalVersion:1},{...event})).toBeUndefined()
    expect(mocks.rpc).toHaveBeenCalledWith('pause_frame_upload_collision',{p_id:'request',p_version:1})
    expect(mocks.updateApproval).not.toHaveBeenCalledWith('request',expect.objectContaining({state:'awaiting'}))
    expect(mocks.fetch.mock.calls.some(([url])=>url.endsWith('/files/move_v2')||url.endsWith('/remote_upload'))).toBe(false)
  })
  it('hands a deleted/recreated source to its exact durable successor without uploading', async () => {
    prior = null; sourceMissing = true; replacementId = 'id:replacement'; sourceRev = 'abcdef99999'
    successorRows = [{ id: 'replacement-event', retired_at: null, payload: {
      ...delivery, dropboxId: replacementId, rev: sourceRev,
    } }]
    mocks.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'claim_dropbox_events' ? [{ ...event }] : true }))
    expect(await drainDropboxInbox(app, { maxBatches: 1 })).toMatchObject({ completed: 1, failed: 0 })
    expect(writes[0]).toMatchObject({ value: { payload: { automatic_resolution: {
      outcome: 'superseded_before_upload', successor_event_id: 'replacement-event', successor_dropbox_id: replacementId,
    } } } })
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remote_upload'))).toBe(false)
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it.each(['missing successor', 'retired successor', 'wrong revision', 'ambiguous', 'lease lost'])('does not lose a replaced-source event: %s', async kind => {
    prior = null; sourceMissing = true; replacementId = 'id:replacement'; sourceRev = 'abcdef99999'
    const next = { id: 'replacement-event', retired_at: null as string | null,
      payload: { ...delivery, dropboxId: replacementId, rev: sourceRev } }
    successorRows = [next]
    if (kind === 'missing successor') successorRows = []
    if (kind === 'retired successor') next.retired_at = new Date().toISOString()
    if (kind === 'wrong revision') next.payload.rev = 'abcdef88888'
    if (kind === 'ambiguous') successorRows.push({ ...next, id: 'second' })
    if (kind === 'lease lost') leaseValid = false
    mocks.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'claim_dropbox_events' ? [{ ...event }] : true }))
    if (kind === 'lease lost') await expect(drainDropboxInbox(app, { maxBatches: 1 })).rejects.toThrow(/lease lost/)
    else expect(await drainDropboxInbox(app, { maxBatches: 1 })).toMatchObject({ completed: 0, deferred: 1 })
    expect(mocks.rpc).not.toHaveBeenCalledWith('complete_dropbox_event', expect.anything())
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remote_upload'))).toBe(false)
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it('does not treat Dropbox auth errors as a removed source', async () => {
    prior = null
    const originalFetch = mocks.fetch.getMockImplementation()!
    mocks.fetch.mockImplementation((url, options) => url.endsWith('/get_metadata')
      ? Promise.resolve(new Response(JSON.stringify({ error: 'denied' }), { status: 403 })) : originalFetch(url, options))
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toThrow(/metadata check failed \(403\)/)
    const metadataCalls = mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/get_metadata'))
    expect(metadataCalls).toHaveLength(1)
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remote_upload'))).toBe(false)
  })
  it('holds a quiet but unfinished render without uploading or notifying, at a one-minute cadence', async () => {
    prior = null; sourceBytes.fill(0)
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toMatchObject({
      delaySeconds: 60, message: expect.stringMatching(/not finalized/),
    })
    expect(writes).toEqual([])
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remote_upload'))).toBe(false)
    expect(mocks.message).not.toHaveBeenCalled()
  })
  it('defers a newer revision arriving during container verification without starting an obsolete upload', async () => {
    prior = null; changeAfterInspection = true
    await expect(handleNewDelivery(app, { ...delivery }, { ...event })).rejects.toMatchObject({
      delaySeconds: 60, message: expect.stringMatching(/changed during verification/),
    })
    expect(writes).toEqual([])
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/remote_upload'))).toBe(false)
  })
  it('defers a fresh source for one minute without consuming its retry budget', async () => {
    prior = null
    mocks.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === 'claim_dropbox_events'
      ? [{ ...event, created_at: new Date().toISOString() }] : true }))
    expect(await drainDropboxInbox(app, { maxBatches: 1 })).toMatchObject({ deferred: 1, failed: 0 })
    expect(mocks.rpc).toHaveBeenCalledWith('defer_dropbox_event', expect.objectContaining({ p_delay_seconds: 60 }))
    expect(mocks.rpc).not.toHaveBeenCalledWith('fail_dropbox_event', expect.anything())
    expect(mocks.message).not.toHaveBeenCalled()
  })
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
    expect(writes[0]).toMatchObject({ table: 'dropbox_event_inbox', value: { payload: { sizeBytes: 256 } } })
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
