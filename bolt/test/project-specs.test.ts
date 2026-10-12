import { beforeEach, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
const m = vi.hoisted(() => ({ actor: vi.fn(), db: vi.fn(), read: vi.fn(), write: vi.fn(), save: vi.fn(), claim: vi.fn(), finish: vi.fn(), lease: vi.fn(), renew: vi.fn(), release: vi.fn(), refresh: vi.fn() }))
vi.mock('../src/handlers/natural-commands', () => ({ commandActor: m.actor }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: m.db }))
vi.mock('../../src/lib/project-control/types', () => ({ workbookConfigFromEnv: () => ({ spreadsheetId: 's' }) }))
vi.mock('../../src/lib/project-control/sheets', () => ({ readBoundProjectSpecs: m.read, writeBoundProjectSpecs: m.write }))
vi.mock('../../src/lib/project-control/store', () => ({ claimWorkbookLease: m.lease, renewWorkbookLease: m.renew, releaseWorkbookLease: m.release }))
vi.mock('../src/handlers/command-store', () => ({ saveCommandRequest: m.save, claimCommandRequest: m.claim, finishCommandRequest: m.finish }))
vi.mock('../src/handlers/project-refresh', () => ({ selectRefreshProject: (projects: unknown[]) => projects[0], requestSlackProjectRefresh: m.refresh }))
import { openProjectSpecs, readProjectSpecsReply, registerProjectSpecsHandlers } from '../src/handlers/project-specs'

const workspace = '00000000-0000-4000-8000-000000000001'
const project = { id: '00000000-0000-4000-8000-000000000002', project_code: '2635-RIOT', slack_channel_id: 'C_RIOT', external_links: {} }
const input = { userId: 'U_CD', teamId: 'T1', channelId: 'C_RIOT', triggerId: 'trigger' }
const rawClient = { conversations: { members: vi.fn(), open: vi.fn() }, views: { open: vi.fn(), update: vi.fn() }, chat: { postMessage: vi.fn() } }
const client = rawClient as unknown as WebClient
let handlers: Map<string, (args: Record<string, unknown>) => Promise<void>>
let currentTier = 'producer'
beforeEach(() => {
  vi.resetAllMocks(); currentTier = 'producer'; handlers = new Map()
  m.actor.mockImplementation(async () => ({ teamId: 'T1', user: { tier: currentTier, workspaceId: workspace, slackUserId: input.userId } }))
  const query = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { project_id: project.id } }) }
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.in.mockResolvedValue({ data: [project] })
  m.db.mockReturnValue({ from: () => query })
  m.read.mockResolvedValue({ values: ['2635', '3840 x 2160', '24', '', '', '', 'hidden', 'Confirmed'], projectNumber: '2635', rowIndex: 5, hash: 'a'.repeat(64) })
  rawClient.conversations.open.mockResolvedValue({ ok: true, channel: { id: 'D_CD' } })
  rawClient.conversations.members.mockResolvedValue({ ok: true, members: ['U_CD'] })
  rawClient.views.open.mockResolvedValue({ ok: true, view: { id: 'loading' } }); rawClient.views.update.mockResolvedValue({ ok: true }); rawClient.chat.postMessage.mockResolvedValue({ ok: true })
  m.save.mockResolvedValue({ id: 'request' }); m.claim.mockResolvedValue(true); m.lease.mockResolvedValue(true); m.renew.mockResolvedValue(true)
  m.write.mockImplementation(async (_c, _p, _h, _v, check) => { await check() })
  m.finish.mockResolvedValue(undefined); m.release.mockResolvedValue(undefined); m.refresh.mockResolvedValue('Refresh queued, not complete.')
  registerProjectSpecsHandlers({ view: (id: string, fn: (args: Record<string, unknown>) => Promise<void>) => handlers.set(id, fn) } as unknown as App)
})
async function submit(overrides: Record<string, unknown> = {}) {
  const metadata = { projectId: project.id, workspaceId: workspace, teamId: 'T1', actor: 'U_CD', source: 'C_RIOT', dm: 'D_CD', hash: 'a'.repeat(64) }
  const values = Object.fromEntries(Object.entries({ dimensions: '3840 x 2160', frameRate: '24', duration: '', audio: '', fileType: '', notes: '' }).map(([key, value]) => [key, { value: { value } }]))
  const ack = vi.fn()
  await handlers.get('kit_project_specs')!({ ack, client, body: { user: { id: 'U_CD' }, team: { id: 'T1' } }, view: { id: 'V1', private_metadata: JSON.stringify(metadata), state: { values } }, ...overrides })
  return ack
}
it('read-only specs checks membership and never creates a confirmation', async () => {
  currentTier = 'artist'
  expect(await readProjectSpecsReply(client, input)).toContain('3840 x 2160')
  expect(m.save).not.toHaveBeenCalled(); expect(rawClient.conversations.open).not.toHaveBeenCalled()
  expect(rawClient.conversations.members).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C_RIOT' }))
  rawClient.conversations.members.mockResolvedValue({ ok: true, members: [] })
  await expect(readProjectSpecsReply(client, input)).rejects.toThrow('membership')
})
it('artist cannot open editing and an inactive/unknown identity never reads', async () => {
  currentTier = 'artist'; await expect(openProjectSpecs(client, input)).rejects.toThrow('Only a producer')
  expect(JSON.stringify(rawClient.views.update.mock.calls)).not.toContain('3840')
  m.actor.mockRejectedValue(new Error('no configured identity'))
  await expect(readProjectSpecsReply(client, input)).rejects.toThrow('identity')
  expect(m.read).not.toHaveBeenCalled()
})
it('private form retains source channel/project and does not write on open', async () => {
  await openProjectSpecs(client, { ...input, suggestion: '4K / 24fps' })
  const view = rawClient.views.update.mock.calls[0][0].view
  expect(JSON.parse(view.private_metadata)).toMatchObject({ source: 'C_RIOT', projectId: project.id, actor: 'U_CD' })
  expect(JSON.stringify(view)).toContain('not yet applied')
  expect(m.write).not.toHaveBeenCalled()
})
it('confirmed form is claimed once, saved, verified, audited and refresh queued', async () => {
  await submit()
  expect(m.write).toHaveBeenCalledOnce(); expect(m.finish).toHaveBeenCalledWith('request', 'complete', true)
  expect(m.refresh).toHaveBeenCalledWith(client, expect.objectContaining({ channelId: 'C_RIOT' }))
  expect(rawClient.chat.postMessage.mock.calls[0][0]).toMatchObject({ channel: 'D_CD' })
  expect(m.release).toHaveBeenCalledOnce()
  m.claim.mockResolvedValue(false); await submit(); expect(m.write).toHaveBeenCalledOnce()
})
it('revoked producer role, wrong actor or workspace cannot execute a saved form', async () => {
  currentTier = 'artist'; await submit(); expect(m.write).not.toHaveBeenCalled()
  currentTier = 'producer'; await submit({ body: { user: { id: 'U_OTHER' }, team: { id: 'T1' } } }); expect(m.write).not.toHaveBeenCalled()
  m.actor.mockResolvedValue({ teamId: 'T1', user: { tier: 'producer', workspaceId: 'another' } })
  await submit(); expect(m.write).not.toHaveBeenCalled()
})
it('ambiguous media specs keep the form open without executing', async () => {
  const ack = await submit({ view: { state: { values: { dimensions: { value: { value: '4K' } } } } } })
  expect(ack).toHaveBeenCalledWith(expect.objectContaining({ response_action: 'errors' })); expect(m.save).not.toHaveBeenCalled()
})
it('uncertain write is marked review; refresh failure never misreports saved specs', async () => {
  m.write.mockRejectedValue(new Error('provider timed out'))
  await submit(); expect(m.finish).toHaveBeenCalledWith('request', 'review', true); expect(m.refresh).not.toHaveBeenCalled()
  expect(rawClient.chat.postMessage.mock.calls[0][0].text).not.toContain('saved and verified')
  m.write.mockResolvedValue(undefined); m.refresh.mockRejectedValue(new Error('offline'))
  await submit(); expect(rawClient.chat.postMessage.mock.calls.at(-1)![0].text).toContain('saved and verified')
})
