import { beforeEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), authorize: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }))
vi.mock('../../src/lib/delivery/upload-approval-store', () => ({ assertUploadReviewer: mocks.authorize }))
import { getAuthorizedUploadPackagePage } from '../../src/lib/delivery/upload-package-store'
import { registerUploadPackageHandlers } from '../src/watchers/upload-package-handlers'
const id = '11111111-1111-1111-1111-111111111111'
const after = '22222222-2222-2222-2222-222222222222'
let workspace: string, page: Record<string, unknown>
beforeEach(() => {
  vi.resetAllMocks()
  workspace = 'ws'
  page = { package: { id, workspace_id: 'ws', project_id: 'project', root_path: '/private/delivery' }, approvals: [], total: 0, awaiting: 0, next_cursor: null }
  mocks.authorize.mockResolvedValue(undefined)
  mocks.rpc.mockImplementation(async () => ({ data: page, error: null }))
  mocks.from.mockImplementation((table: string) => {
    const q = { select: vi.fn(() => q), eq: vi.fn(() => q), single: async () => ({ data: table === 'workspaces' ? { id: workspace } : { id, workspace_id: 'ws', project_id: 'project' }, error: null }) }
    return q
  })
})
it('checks authenticated workspace and current reviewer before reading file names', async () => {
  workspace = 'other'
  await expect(getAuthorizedUploadPackagePage(id, null, 'TEAM', 'USER')).rejects.toThrow('another workspace')
  expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled()
  workspace = 'ws'; mocks.authorize.mockRejectedValue(new Error('Access denied'))
  await expect(getAuthorizedUploadPackagePage(id, null, 'TEAM', 'USER')).rejects.toThrow('Access denied')
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('uses a bounded current page and rejects cross-project files after authorization', async () => {
  await getAuthorizedUploadPackagePage(id, after, 'TEAM', 'USER')
  expect(mocks.authorize).toHaveBeenCalledWith({ id, workspace_id: 'ws', project_id: 'project' }, 'USER')
  expect(mocks.rpc).toHaveBeenCalledWith('get_frame_upload_package_page', { p_id: id, p_after: after, p_limit: 10 })
  page.approvals = [{ workspace_id: 'ws', project_id: 'foreign' }]
  await expect(getAuthorizedUploadPackagePage(id, null, 'TEAM', 'USER')).rejects.toThrow('scope changed')
})
function setupHandler() {
  let handler: (args: unknown) => Promise<void>
  const client = { views: { open: vi.fn().mockResolvedValue({ view: { id: 'modal' } }), update: vi.fn().mockResolvedValue({}) }, chat: { postMessage: vi.fn() } }
  registerUploadPackageHandlers({ action: (_id: unknown, fn: typeof handler) => { handler = fn } } as unknown as App)
  const invoke = (view?: Record<string, unknown>) => handler({ ack: vi.fn(), client,
    body: { trigger_id: 'trigger', user: { id: 'USER' }, team: { id: 'TEAM' }, ...(view ? { view } : {}) },
    action: { value: JSON.stringify({ id, after: view ? after : null }) } })
  return { client, invoke }
}
it('opens a loading modal then a read-only folder review without approving or messaging', async () => {
  const { client, invoke } = setupHandler()
  await invoke()
  expect(client.views.open).toHaveBeenCalledTimes(1)
  const modal = client.views.update.mock.calls[0][0].view
  expect(modal.callback_id).toBe('kit_delivery_package_view'); expect(modal.submit).toBeUndefined()
  expect(client.chat.postMessage).not.toHaveBeenCalled()
  expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['get_frame_upload_package_page'])
})
it('pages within the same modal, reauthorizes, and shows denied access without a fallback ping', async () => {
  const { client, invoke } = setupHandler()
  const view = { id: 'modal', callback_id: 'kit_delivery_package_view' }
  await invoke(view)
  expect(client.views.open).not.toHaveBeenCalled()
  expect(mocks.rpc).toHaveBeenCalledWith('get_frame_upload_package_page', expect.objectContaining({ p_after: after }))
  mocks.authorize.mockRejectedValue(new Error('Private internal reason'))
  await invoke(view)
  const errorModal = client.views.update.mock.calls.at(-1)![0].view
  expect(JSON.stringify(errorModal)).not.toContain('/private/delivery')
  expect(JSON.stringify(errorModal)).not.toContain('Private internal reason')
  expect(client.chat.postMessage).not.toHaveBeenCalled()
})
