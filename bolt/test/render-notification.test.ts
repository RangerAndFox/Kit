import { beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ query: vi.fn(), post: vi.fn(), call: vi.fn(), filter: vi.fn(), save: vi.fn() }))
vi.mock('../../src/lib/inngest/client', () => ({ inngest: { createFunction: (_config: unknown, handler: unknown) => handler } }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: io.query }) }))
vi.mock('../../src/lib/slack/durable-delivery', () => ({ deliverSlackOnce: io.post }))
vi.mock('../../src/lib/slack/transport', () => ({ slackCall: io.call }))
import { deliveryJobNotifier } from '../../src/lib/inngest/delivery-crons'
let job: { id: string; status: string; slack_channel: string; slack_message_ts: string | null; slack_notified_status: string | null }
beforeEach(() => {
  vi.resetAllMocks()
  job = { id: 'job1', status: 'complete', slack_channel: 'C1', slack_message_ts: null, slack_notified_status: null }
  io.post.mockResolvedValue('123.456')
  io.call.mockResolvedValue({ ok: true })
  io.save.mockResolvedValue({ error: null })
  io.query.mockImplementation(() => {
    let updating = false
    const q = {
      select: () => q, in: () => q, eq: () => q, not: () => q, order: () => q,
      or: (value: string) => { io.filter(value); return q },
      limit: async () => ({ data: [{ id: job.id }], error: null }),
      single: async () => ({ data: job, error: null }),
      update: () => { updating = true; return q },
      then: (resolve: (value: unknown) => void) => io.save().then(resolve),
    }
    void updating
    return q
  })
})
const run = deliveryJobNotifier as unknown as (ctx: { step: { run: (key: string, fn: () => Promise<unknown>) => Promise<unknown> } }) => Promise<unknown>
const step = { run: async (_key: string, fn: () => Promise<unknown>) => fn() }
it('terminal receipts are filtered in SQL and acknowledgment errors fail the job', async () => {
  io.save.mockResolvedValueOnce({ error: { message: 'database unavailable' } })
  await expect(run({ step })).rejects.toThrow('acknowledgment')
  expect(io.filter.mock.calls[0][0]).toContain('slack_notified_status.neq.complete')
  expect(io.post).toHaveBeenCalledWith(expect.objectContaining({ key: 'render-job-job1' }))
  expect(io.call).toHaveBeenCalledWith('chat.update', expect.objectContaining({ ts: '123.456' }))
})
it('an existing message is edited without creating another post', async () => {
  job.slack_message_ts = 'existing'
  await run({ step })
  expect(io.post).not.toHaveBeenCalled()
  expect(io.call).toHaveBeenCalledWith('chat.update', expect.objectContaining({ ts: 'existing' }))
})
