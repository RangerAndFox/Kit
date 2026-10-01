import type { App } from '@slack/bolt'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), createTimeEntry: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => mocks }))
vi.mock('../../src/lib/harvest/client', () => ({ createTimeEntry: mocks.createTimeEntry, getDefaultTask: vi.fn() }))
import { nudgePendingCheckins } from '../src/checkins/daily-hours'
import { handleCheckinConfirm } from '../src/checkins/confirm'

const row = { id: 'duplicate', slack_user_id: 'U_OWNER', status: 'parsed', check_in_date: '2026-09-24',
  dm_channel_id: 'D_OWNER', dm_ts: '100.1', nudged_at: null,
  parsed_entries: [{ hours: 8, spentDate: '2026-09-24' }] }

describe('live nudge and confirmation ownership guards', () => {
  const postMessage = vi.fn()
  const app = { client: { chat: { postMessage } } } as unknown as App
  beforeEach(() => { vi.clearAllMocks() })
  it.each([false, null])('does not nudge a stale copy when ownership is %s', async data => {
    mocks.from.mockReturnValue({ select: () => ({ gte: () => ({ in: async () => ({ data: [row], error: null }) }) }) })
    mocks.rpc.mockResolvedValue({ data, error: null })
    expect(await nudgePendingCheckins(app)).toEqual({ nudged: 0 })
    expect(postMessage).not.toHaveBeenCalled()
  })
  it('does not nudge when the ownership read is unavailable', async () => {
    mocks.from.mockReturnValue({ select: () => ({ gte: () => ({ in: async () => ({ data: [row], error: null }) }) }) })
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'offline' } })
    expect(await nudgePendingCheckins(app)).toEqual({ nudged: 0 })
    expect(postMessage).not.toHaveBeenCalled()
  })
  it('still reminds for a legitimate unconfirmed card', async () => {
    mocks.from.mockReturnValueOnce({ select: () => ({ gte: () => ({ in: async () => ({ data: [row], error: null }) }) }) })
    mocks.from.mockReturnValueOnce({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) })
    mocks.rpc.mockResolvedValue({ data: true, error: null })
    expect(await nudgePendingCheckins(app)).toEqual({ nudged: 1 })
    expect(postMessage).toHaveBeenCalledOnce()
  })
  it('clicking a stale copy cannot reach Harvest or claim logging', async () => {
    mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) })
    mocks.rpc.mockResolvedValue({ data: false, error: null })
    await handleCheckinConfirm({ app, client: app.client, body: {}, checkinId: row.id, actorSlackUserId: 'U_OWNER' })
    expect(mocks.createTimeEntry).not.toHaveBeenCalled()
    expect(mocks.from).toHaveBeenCalledTimes(1)
  })
})
