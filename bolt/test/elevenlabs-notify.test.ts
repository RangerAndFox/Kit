import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'

const db = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => db }))
vi.mock('../../src/lib/project-control/sheets', () => ({ upsertProjectLinks: vi.fn() }))
vi.mock('../../src/lib/project-control/sync-request', () => ({ requestProjectControlSync: vi.fn() }))
vi.mock('../../src/lib/project-control/types', () => ({ workbookConfigFromEnv: () => null }))
import { reconcileElevenLabsDraftSlack, resolveElevenLabsDestination } from '../src/storyboard/elevenlabs-notify'
import { getProjectSettings } from '../../src/lib/projects/settings'

type Job = Record<string, unknown>
function setup(jobs: Job[], failAck = false, loseLease = false) {
  const writes: Job[] = []
  db.from.mockImplementation(() => {
    const filters: [string, unknown][] = []
    let change: Job | undefined
    let single = false
    const q = {
      select: () => q, in: () => q, or: () => q, order: () => q, limit: () => q,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return q },
      is: (key: string, value: unknown) => { filters.push([key, value]); return q },
      update: (value: Job) => { change = value; writes.push(value); return q },
      maybeSingle: () => { single = true; return q },
      then: (resolve: (r: unknown) => unknown) => {
        const matches = jobs.filter(j => filters.every(([k, v]) => (j[k] ?? null) === v))
        if (change?.slack_notified_at && failAck) return Promise.resolve(resolve({ data: null, error: { message: 'write failed' } }))
        if (change?.slack_channel_id && loseLease) return Promise.resolve(resolve({ data: null, error: null }))
        matches.forEach(j => { if (change) Object.assign(j, change) })
        return Promise.resolve(resolve({ data: single ? matches[0] ?? null : matches, error: null }))
      },
    }
    return q
  })
  return writes
}
function job(id: string, extra: Job = {}): Job {
  return { id, status: 'failed', project_name: id, requested_by_slack_user_id: 'U123',
    created_at: '2026-09-25T13:00:00Z',
    slack_notified_at: null, slack_notification_disposition: 'pending', ...extra }
}
function slack() {
  const client = {
    conversations: { open: vi.fn().mockResolvedValue({ ok: true, channel: { id: 'D123' } }),
      history: vi.fn().mockResolvedValue({ ok: true, messages: [] }),
      replies: vi.fn().mockResolvedValue({ ok: true, messages: [] }) },
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.2' }) },
  }
  return { client, api: client as unknown as App['client'] }
}
beforeEach(() => vi.clearAllMocks())
describe('ElevenLabs notification routing and retry safety', () => {
  it('opens and persists an actual DM before history and posting', async () => {
    const rows = [job('a')]; setup(rows); const s = slack()
    expect(await reconcileElevenLabsDraftSlack(s.api)).toEqual({ scanned: 1, notified: 1 })
    expect(s.client.conversations.open).toHaveBeenCalledWith({ users: 'U123' })
    expect(s.client.conversations.history.mock.calls[0][0].channel).toBe('D123')
    expect(s.client.conversations.history.mock.calls[0][0].oldest).toBe(String(Date.parse('2026-09-25T12:59:00Z') / 1000))
    expect(rows[0].slack_channel_id).toBe('D123')
    expect(rows[0].slack_notified_at).toBeTruthy()
  })
  it('preserves explicit channel and thread, never falls back on channel errors', async () => {
    setup([job('a', { slack_channel_id: 'C123', slack_thread_ts: '1.1' })]); const s = slack()
    s.client.conversations.replies.mockRejectedValue(new Error('channel_not_found'))
    await expect(reconcileElevenLabsDraftSlack(s.api)).rejects.toThrow('1 job')
    expect(s.client.conversations.open).not.toHaveBeenCalled()
    expect(s.client.chat.postMessage).not.toHaveBeenCalled()
  })
  it('processes later jobs while a missing destination remains an honest failure', async () => {
    const rows = [job('bad', { requested_by_slack_user_id: null }), job('good')]
    setup(rows); const s = slack()
    await expect(reconcileElevenLabsDraftSlack(s.api)).rejects.toThrow('1 job')
    expect(rows[0].slack_notified_at).toBeNull()
    expect(rows[1].slack_notified_at).toBeTruthy()
  })
  it('excludes manual-review and retired jobs without pretending they were notified', async () => {
    const rows = [job('old', { slack_notification_disposition: 'manual_review' }), job('test', { slack_notification_disposition: 'retired' })]
    setup(rows); const s = slack()
    expect(await reconcileElevenLabsDraftSlack(s.api)).toEqual({ scanned: 0, notified: 0 })
    expect(s.client.chat.postMessage).not.toHaveBeenCalled()
    expect(rows.every(j => j.slack_notified_at === null)).toBe(true)
  })
  it('recovers a post whose database acknowledgement failed without reposting', async () => {
    const rows = [job('a')]; setup(rows, true); const s = slack()
    await expect(reconcileElevenLabsDraftSlack(s.api)).rejects.toThrow('1 job')
    setup(rows)
    s.client.conversations.history.mockResolvedValue({ ok: true, messages: [{ metadata: { event_type: 'kit_elevenlabs_result', event_payload: { job_id: 'a' } } }] })
    await reconcileElevenLabsDraftSlack(s.api)
    expect(s.client.chat.postMessage).toHaveBeenCalledTimes(1)
  })
  it('does not post after losing the claim', async () => {
    setup([job('a')], false, true); const s = slack()
    await expect(reconcileElevenLabsDraftSlack(s.api)).rejects.toThrow('1 job')
    expect(s.client.chat.postMessage).not.toHaveBeenCalled()
  })
  it('does not acknowledge an unconfirmed Slack response', async () => {
    const rows = [job('a')]; setup(rows); const s = slack()
    s.client.chat.postMessage.mockResolvedValue({ ok: false })
    await expect(reconcileElevenLabsDraftSlack(s.api)).rejects.toThrow('1 job')
    expect(rows[0].slack_notified_at).toBeNull()
  })
  it('rejects a thread without a real channel, including user-ID legacy channels', async () => {
    const s = slack()
    await expect(resolveElevenLabsDestination(s.api, { slack_channel_id: 'U123', slack_thread_ts: '1' })).rejects.toThrow('thread')
    expect(s.client.conversations.open).not.toHaveBeenCalled()
  })
  it('reconciles beyond the first page rather than duplicating an old receipt', async () => {
    setup([job('a')]); const s = slack()
    s.client.conversations.history.mockResolvedValueOnce({ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: 'next' } })
      .mockResolvedValueOnce({ ok: true, messages: [{ metadata: { event_type: 'kit_elevenlabs_result', event_payload: { job_id: 'a' } } }] })
    await reconcileElevenLabsDraftSlack(s.api)
    expect(s.client.conversations.history).toHaveBeenCalledTimes(2)
    expect(s.client.chat.postMessage).not.toHaveBeenCalled()
  })
})
it('a settings read outage cannot enable retired-project uploads', async () => {
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: { message: 'outage' } }) }
  db.from.mockReturnValue(q)
  await expect(getProjectSettings('p')).rejects.toThrow('unavailable')
})
