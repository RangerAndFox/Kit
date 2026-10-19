import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const io = vi.hoisted(() => ({ db: vi.fn(), access: vi.fn(), validate: vi.fn(), create: vi.fn(),
  get: vi.fn(), step: vi.fn(), save: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: io.db }))
vi.mock('../../src/lib/inngest/access-control', () => ({ resolveUserContext: io.access }))
vi.mock('../../src/lib/archive/dropbox', () => ({ findDeliveryVideos: vi.fn(), validateDropboxVideo: io.validate }))
vi.mock('../../src/lib/archive/draft', () => ({ generateArchiveCopyDraft: vi.fn() }))
vi.mock('../../src/lib/archive/workflow', () => ({ runArchiveJob: vi.fn() }))
vi.mock('../../src/lib/archive/store', () => ({ claimArchiveJob: vi.fn(), createArchiveJob: io.create,
  getArchiveJob: io.get, getArchiveStep: io.step, requeueArchiveJob: vi.fn(), saveArchiveSlackMessage: io.save, updateArchiveJob: vi.fn() }))
import { registerArchiveHandlers } from '../src/archive/handlers'

const project = { id: 'p1', workspace_id: 'w1', name: 'Demo', client: 'Client', project_code: '2639',
  external_ids: { project_number: '2639' }, external_links: {}, status: 'active' }
const values = { source_video: { val: { value: 'https://www.dropbox.com/s/abc/final.mp4?dl=0' } },
  title: { val: { value: 'Keep my edited title' } }, year: { val: { value: '2025' } },
  background_color: { val: { value: '#ffffff' } }, description_1: { val: { value: 'Keep this copy.' } },
  destinations: { val: { selected_options: [{ value: 'dropbox' }] } }, rights: { val: { selected_options: [{ value: 'confirmed' }] } } }
type Handler = (input: unknown) => Promise<void>
type InputBlock = { block_id?: string; element: { initial_value?: string; initial_options?: unknown } }
function makeClient() {
  return { users: { info: vi.fn().mockResolvedValue({}) }, views: {
    open: vi.fn().mockResolvedValue({ view: { id: 'V2' } }), update: vi.fn().mockResolvedValue({}) },
    conversations: { open: vi.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
    chat: { postMessage: vi.fn().mockResolvedValue({ ts: '123' }) } }
}
let views: Record<string, Handler>, actions: Record<string, Handler>
let client: ReturnType<typeof makeClient>
beforeEach(() => {
  vi.resetAllMocks()
  views = {}; actions = {}
  registerArchiveHandlers({ view: (key: string, fn: Handler) => { views[key] = fn },
    action: (key: string, fn: Handler) => { actions[key] = fn } } as unknown as App)
  io.db.mockImplementation(() => ({ from: (table: string) => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: table === 'workspaces' ? { id: 'w1' } : project }) }
    return q
  } }))
  io.access.mockResolvedValue({ tier: 'producer' })
  client = makeClient()
})
const submission = () => ({ ack: vi.fn(), body: { team: { id: 'T1' }, user: { id: 'U1' } }, client,
  view: { id: 'V1', private_metadata: JSON.stringify({ projectId: 'p1', workspaceId: 'w1', channelId: 'D1' }), state: { values } } })
describe('archive source correction', () => {
  it('acknowledges immediately and restores the editable form with all copy after invalid source validation', async () => {
    io.validate.mockRejectedValue(new Error('Paste a link to the video file itself.'))
    const input = submission()
    await views.kit_archive_project_submit(input)
    expect(input.ack.mock.invocationCallOrder[0]).toBeLessThan(io.validate.mock.invocationCallOrder[0])
    expect(io.create).not.toHaveBeenCalled()
    expect(client.chat.postMessage).not.toHaveBeenCalled()
    const restored = client.views.update.mock.calls[0][0].view
    expect(restored.callback_id).toBe('kit_archive_project_submit')
    for (const [key, expected] of Object.entries({ title: 'Keep my edited title', year: '2025', description_1: 'Keep this copy.', background_color: '#ffffff' })) {
      expect(restored.blocks.find((b: InputBlock) => b.block_id === key).element.initial_value).toBe(expected)
    }
  })
  it('stores the canonical Dropbox path and posts confirmation only after validation', async () => {
    io.validate.mockResolvedValue({ path: '/production/final.mp4' })
    io.create.mockResolvedValue({ id: 'j1', project_snapshot: { projectNumber: '2639', projectName: 'Demo' },
      settings: { title: 'Title' }, source_video_path: '/production/final.mp4', destinations: ['dropbox'] })
    await views.kit_archive_project_submit(submission())
    expect(io.validate.mock.invocationCallOrder[0]).toBeLessThan(io.create.mock.invocationCallOrder[0])
    expect(io.create).toHaveBeenCalledWith(expect.objectContaining({ source_video_path: '/production/final.mp4', idempotency_key: 'slack-view:V1' }))
    expect(io.save).toHaveBeenCalledWith('j1', 'D1', '123')
  })
  it('refuses a mismatched workspace before touching Dropbox or creating a job', async () => {
    const input = submission()
    input.view.private_metadata = JSON.stringify({ projectId: 'p1', workspaceId: 'other', channelId: 'D1' })
    await views.kit_archive_project_submit(input)
    expect(io.validate).not.toHaveBeenCalled()
    expect(io.create).not.toHaveBeenCalled()
  })
  it('opens source recovery with saved copy, requires renewed rights approval and does not launch a job', async () => {
    io.get.mockResolvedValue({ id: 'j1', workspace_id: 'w1', status: 'failed', results: {},
      source_video_path: values.source_video.val.value, slack_channel_id: 'D1', destinations: ['dropbox'],
      project_snapshot: { projectId: 'p1', projectNumber: '2639', client: 'Client', projectName: 'Demo' },
      settings: { title: 'Saved title', rightsConfirmed: true } })
    io.step.mockResolvedValue({ status: 'failed' })
    await actions.kit_archive_change_video({ ack: vi.fn(), client, action: { value: 'j1' },
      body: { trigger_id: 'trigger', team: { id: 'T1' }, user: { id: 'U1' } } })
    const form = client.views.update.mock.calls[0][0].view
    expect(form.blocks.find((b: InputBlock) => b.block_id === 'title').element.initial_value).toBe('Saved title')
    expect(form.blocks.find((b: InputBlock) => b.block_id === 'rights').element.initial_options).toBeUndefined()
    expect(io.create).not.toHaveBeenCalled()
  })
  it('refuses source recovery after source validation has already completed', async () => {
    io.get.mockResolvedValue({ id: 'j1', workspace_id: 'w1', status: 'failed', results: {} })
    io.step.mockResolvedValue({ status: 'complete' })
    await actions.kit_archive_change_video({ ack: vi.fn(), client, action: { value: 'j1' },
      body: { trigger_id: 'trigger', team: { id: 'T1' }, user: { id: 'U1' } } })
    expect(client.views.update.mock.calls[0][0].view.callback_id).toBe('kit_archive_loading_error')
    expect(io.create).not.toHaveBeenCalled()
  })
  it('does not reopen editable inputs after creating a job when confirmation delivery fails', async () => {
    io.validate.mockResolvedValue({ path: '/production/final.mp4' })
    io.create.mockResolvedValue({ id: 'saved-job' })
    client.conversations.open.mockRejectedValue(new Error('Slack unavailable'))
    await views.kit_archive_project_submit(submission())
    const result = client.views.update.mock.calls[0][0].view
    expect(result.callback_id).toBe('kit_archive_loading_error')
    expect(JSON.stringify(result)).toContain('saved-job')
    expect(JSON.stringify(result)).not.toContain('plain_text_input')
  })
  it('falls back to a private message when a source error cannot update the modal', async () => {
    io.validate.mockRejectedValue(new Error('Choose a video file.'))
    client.views.update.mockRejectedValue(new Error('view_not_found'))
    await views.kit_archive_project_submit(submission())
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'U1', text: expect.stringContaining('no job was created') }))
  })
  it('falls back to a private message when Change video cannot show its error', async () => {
    io.get.mockResolvedValue(null)
    client.views.update.mockRejectedValue(new Error('view_not_found'))
    await actions.kit_archive_change_video({ ack: vi.fn(), client, action: { value: 'missing' },
      body: { trigger_id: 'trigger', team: { id: 'T1' }, user: { id: 'U1' } } })
    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'U1', text: expect.stringContaining('Could not open Change video') }))
  })
})
