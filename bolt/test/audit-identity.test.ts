import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), gateway: vi.fn(), dispatch: vi.fn(), from: vi.fn() }))
vi.mock('../../src/lib/inngest/agents/registry', () => ({ getCapabilitiesManifest: () => [], dispatch: mocks.dispatch }))
vi.mock('../../src/lib/inngest/access-control', () => ({ resolveUserContext: mocks.resolve, checkGateway: mocks.gateway, filterResultData: (data: unknown) => data }))
vi.mock('../../src/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mocks.from }) }))
import { askAgent, listAgents } from '../../src/lib/mcp/tools/agents'
import { assignProjectAccess } from '../../src/lib/mcp/tools/team'
import { canOnboard } from '../src/onboarding/permissions'

const principal = { subject: 'artist', workspaceId: 'workspace-a', slackUserId: 'UARTIST', tools: ['kit_ask_agent'] }
beforeEach(() => {
  vi.resetAllMocks()
  process.env.KIT_DEFAULT_WORKSPACE_ID = 'workspace-a'
  mocks.resolve.mockResolvedValue({ tier: 'artist', workspaceId: 'workspace-a' })
  mocks.gateway.mockReturnValue({ allowed: false, reason: 'Restricted' })
})

describe('signed MCP actor', () => {
  it('a forged admin argument cannot elevate an artist token', async () => {
    const result = await askAgent.handler({ workspace_id: 'workspace-a', slack_user_id: 'UFOUNDER', agent_id: 'harvest', action: 'budget', payload: {} }, principal)
    expect(mocks.resolve).toHaveBeenCalledWith('workspace-a', 'UARTIST')
    expect(result.isError).toBe(true)
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
  it('rejects old unsigned-actor tokens and cross-workspace calls before lookup', async () => {
    expect((await listAgents.handler({ workspace_id: 'workspace-a', slack_user_id: 'UFOUNDER' }, { ...principal, slackUserId: undefined })).isError).toBe(true)
    expect((await listAgents.handler({ workspace_id: 'workspace-b' }, principal)).isError).toBe(true)
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('overwrites forged nested dispatch identities with the signed identity', async () => {
    mocks.gateway.mockReturnValue({ allowed: true })
    mocks.dispatch.mockResolvedValue({ success: true })
    await askAgent.handler({ workspace_id: 'workspace-a', agent_id: 'brain', action: 'search', payload: { workspaceId: 'workspace-b', slackUserId: 'UFOUNDER', requesterTier: 'admin' } }, principal)
    expect(mocks.dispatch.mock.calls[0][2]).toMatchObject({ workspaceId: 'workspace-a', slackUserId: 'UARTIST', requesterTier: 'artist' })
  })
})

it('onboarding entry rejects CD-only/artist/missing roles instead of failing after the form', async () => {
  for (const tier of ['artist', 'cd', undefined]) {
    mocks.resolve.mockResolvedValue(tier ? { tier } : null)
    expect(await canOnboard('UACTOR')).toBe(false)
  }
  for (const tier of ['producer', 'admin']) {
    mocks.resolve.mockResolvedValue({ tier })
    expect(await canOnboard('UACTOR')).toBe(true)
  }
  expect(mocks.from).not.toHaveBeenCalled()
})

it('project access refuses a foreign member before inserting any grant', async () => {
  const insert = vi.fn()
  mocks.from.mockImplementation((table: string) => {
    const builder = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: table === 'projects' ? { id: 'project-a' } : null, error: null }), insert }
    return builder
  })
  const result = await assignProjectAccess.handler({ workspace_id: 'workspace-a', project_id: 'project-a', team_member_id: 'foreign-member', project_role: 'artist', can_see_financials: true }, principal)
  expect(result.isError).toBe(true)
  expect(insert).not.toHaveBeenCalled()
})
