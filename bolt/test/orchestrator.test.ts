import { describe, it, expect, vi, beforeEach } from 'vitest'

const { createMock, runSpecialistMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  runSpecialistMock: vi.fn(),
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: createMock }
  },
}))

vi.mock('../src/llm/specialist', () => ({
  runSpecialist: runSpecialistMock,
}))

import { runOrchestrator } from '../src/llm/orchestrator'
import { resetMemoryForTest } from '../src/llm/memory'

const fakeUser = {
  teamMemberId: 'tm1',
  workspaceId: 'w1',
  tier: 'producer' as const,
  name: 'Test User',
  slackUserId: 'U1',
  projectFinancials: new Set<string>(),
}

beforeEach(() => {
  createMock.mockReset()
  runSpecialistMock.mockReset()
  resetMemoryForTest()
})

describe('runOrchestrator', () => {
  it('returns text for a chitchat turn (no tool)', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Morning! How can I help?' }],
    })

    const result = await runOrchestrator({
      teamId: 'T1',
      channel: 'C1',
      userId: 'U1',
      user: fakeUser,
      message: 'morning kit',
    })

    expect(result.reply).toBe('Morning! How can I help?')
    expect(result.awaitingClarification).toBe(false)
    expect(runSpecialistMock).not.toHaveBeenCalled()
  })

  it('routes through a specialist when Claude calls ask_<agent>', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_a',
          name: 'ask_harvest',
          input: { query: 'budget on Acme Spot' },
        },
      ],
    })
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Acme Spot: 62% spent — $18.8k left.' }],
    })

    runSpecialistMock.mockResolvedValueOnce(
      'Acme Spot: $50,000 budget, $31,200 spent (62%), $18,800 remaining.',
    )

    const result = await runOrchestrator({
      teamId: 'T1',
      channel: 'C1',
      userId: 'U1',
      user: fakeUser,
      message: 'whats the budget on the acme spot',
    })

    expect(result.reply).toContain('62%')
    expect(runSpecialistMock).toHaveBeenCalledWith(
      'harvest',
      'budget on Acme Spot',
      fakeUser,
      { channelId: 'C1' },
    )
  })

  it('flags awaitingClarification when reply ends with a question mark', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'Two Acme projects came up — Spot or Anthem?' },
      ],
    })

    const result = await runOrchestrator({
      teamId: 'T1',
      channel: 'C1',
      userId: 'U1',
      user: fakeUser,
      message: 'budget on acme',
    })

    expect(result.awaitingClarification).toBe(true)
  })

  it('persists conversation across turns', async () => {
    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Which Acme project?' }],
    })
    await runOrchestrator({
      teamId: 'T1',
      channel: 'C1',
      userId: 'U1',
      user: fakeUser,
      message: 'budget on acme',
    })

    createMock.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Got it.' }],
    })
    await runOrchestrator({
      teamId: 'T1',
      channel: 'C1',
      userId: 'U1',
      user: fakeUser,
      message: 'the spot',
    })

    const secondCallArgs = createMock.mock.calls[1][0]
    expect(secondCallArgs.messages.length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(secondCallArgs.messages)).toContain('budget on acme')
    expect(JSON.stringify(secondCallArgs.messages)).toContain('Which Acme project?')
  })
})
