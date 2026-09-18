import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from }) }))
vi.mock('../../src/lib/control-center/outbox', () => ({ outboxDb: () => ({ from: mocks.from }) }))
vi.mock('../../src/lib/dropbox/client', () => ({ dropboxRpc: async () => ({ result: 'kit-health' }) }))
vi.mock('../../src/lib/frameio/auth', () => ({ frameioHeaders: async () => ({}) }))
vi.mock('../../src/lib/integrations/drive-transcripts', () => ({ driveTranscriptsFolderId: () => null, listTranscriptFiles: vi.fn() }))
import { runIntegrationProbes } from '../../src/lib/health/probes'

let pending: Array<{ id: string; project_id: string }>
let filters: Array<unknown[]>
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  pending = []
  filters = []
  mocks.from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'neq', 'is', 'lt', 'order', 'limit', 'abortSignal']) {
      chain[op] = (...args: unknown[]) => { if (table === 'project_share_events') filters.push([op, ...args]); return chain }
    }
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: table === 'project_share_events' ? pending : [], error: null }).then(resolve)
    return chain
  })
})
afterEach(() => vi.unstubAllGlobals())

it('reports upload-ready but overdue unsent notifications as unhealthy', async () => {
  pending = [{ id: 'event', project_id: '2638' }]
  const result = (await runIntegrationProbes()).find(p => p.key === 'dropbox-inbox')
  expect(result?.ok).toBe(false)
  expect(result?.detail).toContain('notification awaiting recovery')
  expect(filters).toContainEqual(['eq', 'status', 'pending'])
  expect(filters).toContainEqual(['is', 'slack_message_ts', null])
  expect(filters.find(row => row[0] === 'lt')?.[1]).toBe('created_at')
})
it('is healthy when no overdue pending notifications remain', async () => {
  expect((await runIntegrationProbes()).find(p => p.key === 'dropbox-inbox')?.ok).toBe(true)
})
