import { beforeEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ scan: vi.fn(), mark: vi.fn(), post: vi.fn(), convert: vi.fn(), attempt: vi.fn(), success: vi.fn() }))
vi.mock('../../src/lib/inngest/client', () => ({ inngest: { createFunction: (_config: unknown, handler: unknown) => handler } }))
vi.mock('../../src/lib/delivery/dropbox-watcher', () => ({ scanDeliveryQueue: io.scan, markFileNotified: io.mark, resolveDeliveryChannel: async () => ({ channelId: 'C1', projectName: 'Project' }) }))
vi.mock('../../src/lib/delivery/subtitle-watcher', () => ({ processSrtFile: io.convert }))
vi.mock('../../src/lib/delivery/specs-watcher', () => ({ runSpecsScanTick: vi.fn() }))
vi.mock('../../src/lib/health/state', () => ({ recordCronSuccess: io.success, recordCronAttempt: io.attempt }))
vi.mock('../../src/lib/slack/durable-delivery', () => ({ deliverSlackOnce: io.post }))
import { deliveryDropboxScan } from '../../src/lib/inngest/delivery-crons'

beforeEach(() => {
  vi.resetAllMocks()
  process.env.DROPBOX_ACCESS_TOKEN = 'test'
  process.env.SLACK_BOT_TOKEN = 'test'
  io.scan.mockResolvedValue([
    { dropbox_id: 'movie', path: '/Delivery-Queue/p/movie.mp4', size_bytes: 100 },
    { dropbox_id: 'captions', path: '/Delivery-Queue/p/movie.srt', size_bytes: 100 },
  ])
  io.convert.mockResolvedValue({ generated: ['/Delivery-Queue/p/movie.vtt'], cueCount: 1 })
  io.post.mockResolvedValue('1.2')
})

it('mixed media/SRT replay posts each notification once and stamps success only after work', async () => {
  let posts = 0
  vi.stubGlobal('fetch', async () => { posts++; return new Response(JSON.stringify({ ok: true, ts: String(posts) })) })
  const memo = new Map<string, unknown>()
  const step = { run: async (id: string, work: () => Promise<unknown>) => {
    if (memo.has(id)) return memo.get(id)
    const result = await work()
    memo.set(id, result)
    return result
  } }
  const run = deliveryDropboxScan as unknown as (context: { step: typeof step; logger: { warn: () => void } }) => Promise<unknown>
  try {
    await run({ step, logger: { warn: () => {} } })
    await run({ step, logger: { warn: () => {} } })
    expect(io.post).toHaveBeenCalledTimes(2)
    expect(io.mark).toHaveBeenCalledTimes(2)
    expect(io.convert).toHaveBeenCalledTimes(1)
    expect(io.attempt).toHaveBeenCalledTimes(1)
    expect(io.success).toHaveBeenCalledTimes(1)
    expect(io.success.mock.invocationCallOrder[0]).toBeGreaterThan(io.convert.mock.invocationCallOrder[0])
  } finally { vi.unstubAllGlobals() }
})

it('caption notification failure does not consume the caption event', async () => {
  io.scan.mockResolvedValue([{ dropbox_id: 'captions', path: '/Delivery-Queue/p/movie.srt', size_bytes: 100 }])
  io.post.mockRejectedValue(new Error('Slack outcome unconfirmed'))
  const step = { run: async (_id: string, work: () => Promise<unknown>) => work() }
  const run = deliveryDropboxScan as unknown as (context: { step: typeof step; logger: { warn: () => void } }) => Promise<unknown>
  await expect(run({ step, logger: { warn: () => {} } })).rejects.toThrow('unconfirmed')
  expect(io.mark).not.toHaveBeenCalled()
  expect(io.success).not.toHaveBeenCalled()
})
