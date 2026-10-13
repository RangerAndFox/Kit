import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const mocks = vi.hoisted(() => ({ get: vi.fn(), authorize: vi.fn(), db: vi.fn(), log: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: mocks.db }))
vi.mock('../../src/lib/delivery/upload-approval-store', () => ({ getUploadApproval: mocks.get, assertUploadReviewer: mocks.authorize, uploadApprovalsEnabled: () => true }))
vi.mock('../src/watchers/dropbox', () => ({ uploadApprovalConflicts: vi.fn(), verifyApprovalSource: vi.fn() }))
vi.mock('../src/watchers/upload-review-diagnostics', () => ({ uploadReviewDiagnostic: mocks.log }))
import { registerUploadApprovalHandlers } from '../src/watchers/upload-approval-handlers'

const client = { views: { open: vi.fn(), update: vi.fn() }, chat: { postMessage: vi.fn() } }
const click = { ack: vi.fn(), body: { trigger_id: 'SECRET', team: { id: 'T1' }, user: { id: 'U123' } },
  action: { action_id: 'kit_frame_upload_review', value: 'request' }, client }
let handler: (input: typeof click) => Promise<void>
beforeEach(() => {
  vi.resetAllMocks()
  registerUploadApprovalHandlers({ action: (key: string | RegExp, callback: typeof handler) => {
    if (key instanceof RegExp && key.test(click.action.action_id)) handler = callback
  }, view: () => {} } as unknown as App)
  client.views.open.mockResolvedValue({ view: { id: 'V1' } })
  client.views.update.mockResolvedValue({ ok: true })
  mocks.get.mockResolvedValue({ id: 'request', workspace_id: 'w1', state: 'awaiting', source_path: '/file.mov', suggested_name: 'R&F_Client_Project.mov' })
  const query = { select: () => query, eq: () => query, single: async () => ({ data: { id: 'w1' } }) }
  mocks.db.mockReturnValue({ from: () => query })
})
afterEach(() => vi.restoreAllMocks())
describe('upload review button diagnostics', () => {
  it('opens immediately before DB reads, then authorizes and populates without uploading', async () => {
    await handler(click)
    expect(click.ack).toHaveBeenCalledOnce()
    expect(client.views.open.mock.invocationCallOrder[0]).toBeLessThan(mocks.get.mock.invocationCallOrder[0])
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ id: 'request' }), 'U123')
    expect(client.views.update).toHaveBeenCalledWith(expect.objectContaining({ view_id: 'V1', view: expect.objectContaining({ callback_id: 'kit_frame_upload_submit' }) }))
    expect(mocks.log).toHaveBeenCalledWith('review_form_ready', expect.anything())
  })
  it('records form opening failure and tells the reviewer privately', async () => {
    client.views.open.mockRejectedValue(Object.assign(new Error('Slack rejected trigger'), { data: { error: 'expired_trigger_id' } }))
    await handler(click)
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.log).toHaveBeenCalledWith('open_form_failed', expect.objectContaining({ error: expect.any(Error) }))
    expect(client.chat.postMessage).toHaveBeenCalledWith({ channel: 'U123', text: expect.stringContaining('Upload review:') })
  })
  it('keeps authorization failures inside the modal and records failed error feedback', async () => {
    mocks.authorize.mockRejectedValue(new Error('Access denied'))
    client.views.update.mockRejectedValue(new Error('Slack unavailable'))
    await handler(click)
    expect(mocks.log).toHaveBeenCalledWith('authorize_failed', expect.anything())
    expect(mocks.log).toHaveBeenCalledWith('error_feedback_failed', expect.anything())
  })
  it('does not silently swallow a malformed action', async () => {
    await handler({ ...click, action: { ...click.action, value: '' } })
    expect(mocks.log).toHaveBeenCalledWith('invalid_action_failed', expect.anything())
    expect(client.chat.postMessage).toHaveBeenCalledOnce()
    expect(client.views.open).not.toHaveBeenCalled()
  })
})
