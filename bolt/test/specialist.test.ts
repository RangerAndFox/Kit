import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted mocks (vi.mock is hoisted to top of file, so factories must use vi.hoisted)
const { createMock, dispatchMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  dispatchMock: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: createMock }
    },
  }
})

vi.mock('../../src/lib/inngest/agents/registry', async () => {
  const actual: any = await vi.importActual(
    '../../src/lib/inngest/agents/registry',
  )
  return {
    ...actual,
    dispatch: dispatchMock,
  }
})

// Mock access control. checkGateway defaults to allowed; individual tests
// override it to exercise the pre-dispatch gate.
const { gatewayMock } = vi.hoisted(() => ({ gatewayMock: vi.fn(() => ({ allowed: true })) }))
vi.mock('../../src/lib/inngest/access-control', () => ({
  checkGateway: gatewayMock,
  enforceAccess: vi.fn(async (_user, _agent, _action, _payload, result) => result),
  failsafeArtistContext: vi.fn((workspaceId, slackUserId) => ({
    teamMemberId: `unknown:${slackUserId}`,
    workspaceId,
    tier: 'artist',
    name: 'unknown user',
    slackUserId,
    projectFinancials: new Set(),
  })),
}))

import { runSpecialist } from '../src/llm/specialist'

const fakeUser = {
  teamMemberId: 'tm1',
  workspaceId: 'w1',
  tier: 'producer' as const,
  name: 'Test User',
  slackUserId: 'U1',
  projectFinancials: new Set<string>(['p1']),
}

beforeEach(() => {
  createMock.mockReset()
  dispatchMock.mockReset()
  gatewayMock.mockReset()
  gatewayMock.mockReturnValue({ allowed: true })
})

describe('runSpecialist', () => {
  it('calls a tool then returns the summary', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'harvest_get_budget',
          input: { payload: { project: 'Acme' } },
        },
      ],
    })
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Acme: $10k of $20k spent.' }],
    })

    dispatchMock.mockResolvedValueOnce({
      agent: 'harvest',
      action: 'get_budget',
      success: true,
      data: { budget_total: 20000, budget_spent: 10000 },
    })

    const result = await runSpecialist('harvest', 'budget on Acme', fakeUser)

    expect(result).toBe('Acme: $10k of $20k spent.')
    // The specialist injects caller identity into every payload — the LLM
    // never supplies it. Assert the enrichment so a regression here (which
    // would break access control downstream) fails loudly.
    expect(dispatchMock).toHaveBeenCalledWith('harvest', 'get_budget', {
      project: 'Acme',
      slackUserId: 'U1',
      teamMemberId: 'tm1',
      channelId: undefined,
    })
    expect(createMock).toHaveBeenCalledTimes(2)
  })

  it('returns the assistant text directly when no tool call is made', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I cannot answer that.' }],
    })

    const result = await runSpecialist('harvest', 'something off-topic', fakeUser)
    expect(result).toBe('I cannot answer that.')
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('passes through agent errors as the summary', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'harvest_get_budget',
          input: { payload: { project: 'Nope' } },
        },
      ],
    })
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'No project matched "Nope".' }],
    })

    dispatchMock.mockResolvedValueOnce({
      agent: 'harvest',
      action: 'get_budget',
      success: false,
      error: 'No project matched "Nope"',
    })

    const result = await runSpecialist('harvest', 'budget on Nope', fakeUser)
    expect(result).toContain('No project matched "Nope"')
  })

  it('blocks a gated action BEFORE dispatch (no side effect for denied users)', async () => {
    // The LLM tries to call a gated mutation...
    createMock.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'harvest_provision',
          input: { payload: { projectName: 'X', client: 'Y' } },
        },
      ],
    })
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: "That's restricted." }],
    })
    // ...but the gateway denies it.
    gatewayMock.mockReturnValue({ allowed: false, reason: 'restricted' })

    await runSpecialist('harvest', 'make a project', fakeUser)

    // The action must NOT have executed.
    expect(dispatchMock).not.toHaveBeenCalled()
  })
})
