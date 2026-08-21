import { describe, it, expect, vi } from 'vitest'

import {
  looksLikeRecoverableCheckinReply,
  recoverMissedCheckinReplies,
  type RecoverableCheckin,
  type ReplyRecoveryDeps,
} from '../src/checkins/reply-recovery'

const ROW: RecoverableCheckin = {
  id: 'checkin-1',
  staff_id: 'staff-1',
  slack_user_id: 'U_ME',
  check_in_date: '2026-08-21',
  status: 'sent',
  dm_channel_id: 'C_PERSONAL',
  dm_ts: '1000.000001',
  reply_ts: null,
  candidate_projects: [],
}

describe('missed hours reply recovery', () => {
  it('accepts explicit hours and skip replies but ignores unrelated conversation', () => {
    expect(looksLikeRecoverableCheckinReply('2 hours Fabric\n30 mins Biz Apps')).toBe(true)
    expect(looksLikeRecoverableCheckinReply('skip')).toBe(true)
    expect(looksLikeRecoverableCheckinReply("didn't work!")).toBe(true)
    expect(looksLikeRecoverableCheckinReply("what's the Frame.io link?")).toBe(false)
  })

  it('recovers the first contiguous reply burst through the normal handler', async () => {
    const handle = vi.fn(async () => true)
    const deps: ReplyRecoveryDeps = {
      loadOpen: async () => [ROW],
      readMessages: async () => [
        { ts: '1002.000001', user: 'U_ME', text: '30 mins Biz Apps' },
        { ts: '1001.000001', user: 'U_ME', text: '2 hours Fabric' },
        { ts: '1001.500001', bot_id: 'B_KIT', text: 'bot text' },
      ],
      handle,
      handleParsed: vi.fn(async () => true),
    }

    const result = await recoverMissedCheckinReplies({} as any, deps)

    expect(result).toEqual({ scanned: 1, recovered: 1, ignored: 0, failed: 0 })
    expect(handle).toHaveBeenCalledOnce()
    expect(handle).toHaveBeenCalledWith(
      ROW,
      '2 hours Fabric\n30 mins Biz Apps',
      '1001.000001',
    )
  })

  it('does not feed unrelated personal-channel messages to the hours parser', async () => {
    const handle = vi.fn(async () => true)
    const deps: ReplyRecoveryDeps = {
      loadOpen: async () => [ROW],
      readMessages: async () => [
        { ts: '1001.000001', user: 'U_ME', text: 'Can you find the client brief?' },
      ],
      handle,
      handleParsed: vi.fn(async () => true),
    }

    const result = await recoverMissedCheckinReplies({} as any, deps)
    expect(result).toEqual({ scanned: 1, recovered: 0, ignored: 1, failed: 0 })
    expect(handle).not.toHaveBeenCalled()
  })

  it('isolates a channel read failure so another open check-in can recover', async () => {
    const second = { ...ROW, id: 'checkin-2', slack_user_id: 'U_TWO' }
    const handle = vi.fn(async () => true)
    const deps: ReplyRecoveryDeps = {
      loadOpen: async () => [ROW, second],
      readMessages: async (row) => {
        if (row.id === ROW.id) throw new Error('missing_scope')
        return [{ ts: '1001.000001', user: 'U_TWO', text: '4h on 2637' }]
      },
      handle,
      handleParsed: vi.fn(async () => true),
    }

    const result = await recoverMissedCheckinReplies({} as any, deps)
    expect(result).toEqual({ scanned: 2, recovered: 1, ignored: 0, failed: 1 })
    expect(handle).toHaveBeenCalledOnce()
  })

  it('recovers a typed confirmation for an already parsed check-in', async () => {
    const parsed = { ...ROW, status: 'parsed', reply_ts: '1001.000001' }
    const handle = vi.fn(async () => true)
    const handleParsed = vi.fn(async () => true)
    const deps: ReplyRecoveryDeps = {
      loadOpen: async () => [parsed],
      readMessages: async () => [{ ts: '1002.000001', user: 'U_ME', text: 'yes' }],
      handle,
      handleParsed,
    }

    const result = await recoverMissedCheckinReplies({} as any, deps)
    expect(result).toEqual({ scanned: 1, recovered: 1, ignored: 0, failed: 0 })
    expect(handle).not.toHaveBeenCalled()
    expect(handleParsed).toHaveBeenCalledWith(parsed, 'yes')
  })

  it('does not treat an hours message as confirmation after the row is parsed', async () => {
    const parsed = { ...ROW, status: 'parsed', reply_ts: '1001.000001' }
    const handleParsed = vi.fn(async () => true)
    const deps: ReplyRecoveryDeps = {
      loadOpen: async () => [parsed],
      readMessages: async () => [{ ts: '1002.000001', user: 'U_ME', text: '4h on 2637' }],
      handle: vi.fn(async () => true),
      handleParsed,
    }

    const result = await recoverMissedCheckinReplies({} as any, deps)
    expect(result).toEqual({ scanned: 1, recovered: 0, ignored: 1, failed: 0 })
    expect(handleParsed).not.toHaveBeenCalled()
  })
})
