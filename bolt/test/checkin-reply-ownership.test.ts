import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc }) }))
import { checkinActionIsCurrent, isReplyOwnershipConflict } from '../src/checkins/reply-ownership'
import { buildConfirmBlocks } from '../src/checkins/reply'

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
  it('does not label a historical check-in anchor as Today', () => {
    const card = JSON.stringify(buildConfirmBlocks({ checkinId: 'old', anchorDate: '2026-09-24', currentDate: '2026-10-01', entries: [
      { projectQuery: '2638', hours: 1, spentDate: '2026-09-24', resolution: 'matched', harvest_project_name: 'CS Demo' },
    ] }))
    expect(card).toContain('Thursday, September 24, 2026')
    expect(card).not.toContain('Today')
  })
})
