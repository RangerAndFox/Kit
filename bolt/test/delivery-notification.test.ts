import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ from: vi.fn(), metadata: vi.fn(), row: vi.fn(), config: vi.fn() }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from }) }))
vi.mock('../../src/lib/project-control/sheets', () => ({ searchRowMetadata: mocks.metadata, readRow: mocks.row, readLatestShare: vi.fn(), recordLatestShare: vi.fn() }))
vi.mock('../../src/lib/project-control/types', () => ({ workbookConfigFromEnv: mocks.config }))
import { notifyProjectShare } from '../src/watchers/dropbox'

const producer = { full_name: 'Jennifer', slack_user_id: 'UJENNIFER', role: 'producer', is_active: true }
const input = {
  project: { id: '2638', name: 'Customer Service', client: 'Microsoft', project_manager_slack_id: 'UOLD', external_links: { slack_id: 'CARTISTS' } },
  folderLabel: '01_Client Progress / edit V1', subfolderLine: '01_Client Progress / edit V1', reviewUrl: 'https://frame.example/folder',
  progression: { eventId: 'event', milestone: null, confidence: 'uncertain' as const },
}
let responses: Record<string, Array<{ data?: unknown; error?: { message: string } | null }>>
let updates: Array<{ table: string; value: unknown }>

beforeEach(() => {
  vi.clearAllMocks()
  updates = []
  responses = {
    project_share_events: [{ data: { status: 'pending', slack_message_ts: null } }, { error: null }],
    project_control_bindings: [{ data: { spreadsheet_id: 'sheet', sheet_id: 1 } }],
    staff: [{ data: [producer] }], projects: [{ error: null }], frameio_folder_shares: [{ error: null }],
  }
  mocks.from.mockImplementation((table: string) => {
    const result = responses[table]?.shift()
    if (!result) throw new Error(`Unexpected DB call: ${table}`)
    const chain: Record<string, unknown> = {}
    for (const name of ['select', 'eq', 'in', 'is', 'order', 'limit']) chain[name] = vi.fn(() => chain)
    chain.update = vi.fn((value) => { updates.push({ table, value }); return chain })
    chain.single = chain.maybeSingle = vi.fn(async () => result)
    chain.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  mocks.config.mockReturnValue({ spreadsheetId: 'sheet', sheetId: 1 })
  mocks.metadata.mockResolvedValue({ rowIndex: 12 })
  mocks.row.mockResolvedValue(Array.from({ length: 25 }, (_, i) => i === 11 ? { formattedValue: 'Jennifer' } : {}))
})

describe('folder notification boundary', () => {
  const app = () => ({ client: { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '123.456' }) } } })
  it('uses the current Sheet producer, privately, and checkpoints only after Slack acknowledges', async () => {
    const slack = app()
    await notifyProjectShare(slack as never, input)
    expect(slack.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'UJENNIFER' }))
    expect(updates).toContainEqual({ table: 'projects', value: expect.objectContaining({ project_manager_slack_id: 'UJENNIFER' }) })
    expect(updates).toContainEqual({ table: 'project_share_events', value: expect.objectContaining({ slack_message_ts: '123.456' }) })
  })
  it('does not resend the operator-dismissed 2638 event', async () => {
    responses.project_share_events = [{ data: { status: 'dismissed', slack_message_ts: null } }]
    const slack = app()
    await notifyProjectShare(slack as never, input)
    expect(slack.client.chat.postMessage).not.toHaveBeenCalled()
    expect(mocks.metadata).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })
  it('leaves missing routing retryable, never falling back to the artist channel', async () => {
    mocks.row.mockResolvedValue([])
    const slack = app()
    await expect(notifyProjectShare(slack as never, input)).rejects.toThrow(/producer is missing/)
    expect(slack.client.chat.postMessage).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })
  it('leaves a Google outage retryable rather than sending to stale ownership', async () => {
    mocks.metadata.mockRejectedValue(new Error('Google unavailable'))
    const slack = app()
    await expect(notifyProjectShare(slack as never, input)).rejects.toThrow(/Google unavailable/)
    expect(slack.client.chat.postMessage).not.toHaveBeenCalled()
  })
  it('does not acknowledge a failed Slack send in the ledger', async () => {
    const slack = app()
    slack.client.chat.postMessage.mockResolvedValue({ ok: false, ts: '' })
    await expect(notifyProjectShare(slack as never, input)).rejects.toThrow(/acknowledge/)
    expect(updates.some(u => u.table === 'project_share_events')).toBe(false)
  })
  it('never reads a stale workbook binding', async () => {
    mocks.config.mockReturnValue({ spreadsheetId: 'other-sheet', sheetId: 1 })
    const slack = app()
    await expect(notifyProjectShare(slack as never, input)).rejects.toThrow(/authoritative workbook/)
    expect(slack.client.chat.postMessage).not.toHaveBeenCalled()
  })
})
