import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc }) }))
import { checkinActionIsCurrent, isReplyOwnershipConflict } from '../src/checkins/reply-ownership'
import { buildConfirmBlocks, handleCheckinReply } from '../src/checkins/reply'

describe('check-in reply ownership', () => {
  beforeEach(() => rpc.mockReset())
  it('fails closed on read errors and missing claims', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'unavailable' } })
    await expect(checkinActionIsCurrent('row', 'parsed')).rejects.toThrow('ownership unavailable')
    rpc.mockResolvedValueOnce({ data: null, error: null })
    expect(await checkinActionIsCurrent('row', 'parsed')).toBe(false)
    rpc.mockResolvedValueOnce({ data: false, error: null })
    expect(await checkinActionIsCurrent('row', 'parsed')).toBe(false)
    rpc.mockResolvedValueOnce({ data: true, error: null })
    expect(await checkinActionIsCurrent('row', 'parsed')).toBe(true)
    expect(rpc).toHaveBeenLastCalledWith('checkin_action_is_current', { p_checkin_id: 'row', p_expected_status: 'parsed' })
  })
  it('only treats the explicit ownership conflict as already consumed', () => {
    expect(isReplyOwnershipConflict({ code: '23505', message: 'checkin_reply_already_owned' })).toBe(true)
    expect(isReplyOwnershipConflict({ code: '23505', message: 'some other constraint' })).toBe(false)
    expect(isReplyOwnershipConflict(null)).toBe(false)
  })
  it('consumes a duplicate recovery event before parsing or adhoc fallback', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'checkin_reply_already_owned' } })
    const app = {} as App
    const open = { id: 'old', staff_id: 'staff', slack_user_id: 'U_ME', check_in_date: '2026-09-24',
      status: 'sent', dm_channel_id: 'D_ME', dm_ts: '100.1', candidate_projects: [] }
    expect(await handleCheckinReply({ app, open, replyText: '1h CS Demo\n2h CS Teams', replyTs: '200.1', replyTimestamps: ['200.1', '200.2'] })).toBe(true)
    expect(rpc).toHaveBeenCalledWith('claim_checkin_reply', { p_checkin_id: 'old', p_reply_timestamps: ['200.1', '200.2'] })
    rpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })
    await expect(handleCheckinReply({ app, open, replyText: '1h CS Demo', replyTs: '200.1' })).rejects.toThrow('reply claim failed')
  })
  it('does not label a historical check-in anchor as Today', () => {
    const card = JSON.stringify(buildConfirmBlocks({ checkinId: 'old', anchorDate: '2026-09-24', currentDate: '2026-10-01', entries: [
      { projectQuery: '2638', hours: 1, spentDate: '2026-09-24', resolution: 'matched', harvest_project_name: 'CS Demo' },
    ] }))
    expect(card).toContain('Thursday, September 24, 2026')
    expect(card).not.toContain('Today')
  })
})
