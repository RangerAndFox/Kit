import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ actor: vi.fn(), db: vi.fn(), send: vi.fn() }))
vi.mock('../src/handlers/natural-commands', () => ({ commandActor: mocks.actor }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: mocks.db }))
vi.mock('../../src/lib/inngest/client', () => ({ inngest: { send: mocks.send } }))
import { requestSlackProjectRefresh, selectRefreshProject } from '../src/handlers/project-refresh'
import { parseFastCommand } from '../src/handlers/command-catalog'
import type { WebClient } from '@slack/web-api'

const project = { id: 'p1', project_code: '2645-Microsoft', slack_channel_id: null, external_links: { slack_id: 'CPROJECT' } }
const client = { conversations: { open: vi.fn() } } as unknown as WebClient
const rpc = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('MASTER_PROJECT_LIST_SPREADSHEET_ID', 'sheet')
  vi.stubEnv('MASTER_PROJECT_LIST_SHEET_ID', '1')
  vi.stubEnv('PROJECT_CONTROL_SYNC_ENABLED', 'true')
  vi.stubEnv('INNGEST_EVENT_KEY', '')
  mocks.actor.mockResolvedValue({ user: { workspaceId: 'w1', tier: 'producer' } })
  vi.mocked(client.conversations.open).mockResolvedValue({ ok: true, channel: { id: 'DPRIVATE' } })
  rpc.mockResolvedValue({ data: 'request', error: null })
  mocks.db.mockReturnValue({ rpc, from: (table: string) => {
    const q = { select: () => q, eq: () => q, in: () => q, then: (resolve: (v: unknown) => void) => resolve({ data: table === 'projects' ? [project] : [{ project_id: 'p1', refresh_channel_id: 'CPROJECT' }], error: null }) }
    return q
  } })
})
afterEach(() => vi.unstubAllEnvs())
const input = { userId: 'UACTOR', teamId: 'TSTUDIO', channelId: 'CPROJECT' }

describe('project refresh', () => {
  it('resolves canonical numbers and historical Slack link bindings without guessing', () => {
    expect(selectRefreshProject([project], 'CPROJECT', '')).toEqual(project)
    expect(selectRefreshProject([project], 'DPRIVATE', '2645')).toEqual(project)
    expect(() => selectRefreshProject([project], 'DPRIVATE', '264')).toThrow()
    expect(() => selectRefreshProject([project, { ...project, id: 'p2' }], 'CPROJECT', '')).toThrow()
  })
  it('queues a producer request and says queued, not completed', async () => {
    const result = await requestSlackProjectRefresh(client, input)
    expect(result).toContain('Refresh queued')
    expect(rpc).toHaveBeenCalledWith('enqueue_slack_project_refresh', expect.objectContaining({ p_workspace_id: 'w1', p_project_id: 'p1', p_actor: 'UACTOR', p_dm_channel: 'DPRIVATE' }))
    expect(result).not.toContain('synced successfully')
  })
  it('denies an artist before project reads or writes', async () => {
    mocks.actor.mockResolvedValue({ user: { workspaceId: 'w1', tier: 'artist' } })
    await expect(requestSlackProjectRefresh(client, input)).rejects.toThrow('Only producers')
    expect(mocks.db).not.toHaveBeenCalled()
  })
  it('rejects a forwarded/tampered button and missing DM; never posts completion into a project channel', async () => {
    await expect(requestSlackProjectRefresh(client, { ...input, projectId: 'p1', channelId: 'COTHER' })).rejects.toThrow('original project channel')
    expect(rpc).not.toHaveBeenCalled()
    vi.mocked(client.conversations.open).mockResolvedValue({ ok: false })
    await expect(requestSlackProjectRefresh(client, input)).rejects.toThrow('private Kit DM')
    expect(rpc).not.toHaveBeenCalled()
  })
  it('preserves the queued request when immediate wake-up is unavailable', async () => {
    vi.stubEnv('INNGEST_EVENT_KEY', 'test-key')
    mocks.send.mockRejectedValue(new Error('outage'))
    expect(await requestSlackProjectRefresh(client, input)).toContain('Refresh queued')
  })
  it('natural language uses refresh, not Harvest reconciliation', () => {
    for (const text of ['Kit sync this project', 'refresh project 2645', 'sync 2645 now', '/kit refresh 2645']) expect(parseFastCommand(text)?.command).toBe('refresh')
    expect(parseFastCommand('sync projects from harvest')?.command).toBe('sync-projects')
    expect(parseFastCommand('do not sync this project')).toBeNull()
  })
})
