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
  it('explains onboarding before offering to start, without any model or action calls', async () => {
    const openCommand = vi.fn()
    const result = await runOrchestrator({ teamId: 'T1', channel: 'D1', userId: 'U1', user: fakeUser, message: 'How do I onboard an artist?', openCommand })
    expect(result.guidance).toBe('onboard')
    expect(result.reply).toContain('correct full name and email')
    expect(result.reply).toContain('Want me to open the onboarding setup now?')
    expect(openCommand).not.toHaveBeenCalled()
    expect(runSpecialistMock).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })
  it('supports semantic how-to questions through an explanation-only tool surface', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'x', name: 'explain_kit_command', input: { command: 'onboard' } },
      { type: 'tool_use', id: 'y', name: 'open_kit_command', input: { command: 'onboard', args: '' } },
      { type: 'tool_use', id: 'z', name: 'ask_slack', input: { query: 'invite someone' } },
    ] })
    const openCommand = vi.fn()
    const result = await runOrchestrator({ teamId: 'T1', channel: 'D1', userId: 'U1', user: fakeUser, message: 'Walk me through getting a collaborator set up', openCommand })
    expect(result.guidance).toBe('onboard')
    expect(createMock.mock.calls[0][0].tools.map((t: { name: string }) => t.name)).toEqual(['explain_kit_command'])
    expect(openCommand).not.toHaveBeenCalled()
    expect(runSpecialistMock).not.toHaveBeenCalled()
  })
  it.each(['ask_slack', 'open_kit_command'])('blocks hallucinated %s calls during instruction-only turns', async name => {
    createMock.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name, input: { command: 'onboard', args: '' } }] })
    const openCommand = vi.fn()
    const result = await runOrchestrator({ teamId: 'T1', channel: 'D1', userId: 'U1', user: fakeUser, message: 'Explain how that thing works', openCommand })
    expect(result.reply).toContain('Which Kit function')
    expect(openCommand).not.toHaveBeenCalled()
    expect(runSpecialistMock).not.toHaveBeenCalled()
  })
  it('rejects invalid model-supplied guidance rather than reflecting raw input', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'explain_kit_command', input: { command: 'onboard', email: 'private@example.test' } }] })
    const result = await runOrchestrator({ teamId: 'T1', channel: 'D1', userId: 'U1', user: fakeUser, message: 'Explain that workflow' })
    expect(result.guidance).toBeUndefined()
    expect(result.reply).not.toContain('private@example')
    expect(runSpecialistMock).not.toHaveBeenCalled()
  })
  it('offers a command through a host callback and never runs sibling specialist writes', async () => {
    const openCommand = vi.fn().mockResolvedValue('Private review card opened. Nothing has run.')
    createMock.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'side', name: 'ask_slack', input: { query: 'create a channel' } },
      { type: 'tool_use', id: 'command', name: 'open_kit_command', input: { command: 'newproject', args: '' } },
    ] })
    const result = await runOrchestrator({ teamId: 'T1', channel: 'C1', userId: 'U1', user: fakeUser, message: 'Please get a project ready for us', openCommand })
    expect(openCommand).toHaveBeenCalledWith({ command: 'newproject', args: '' })
    expect(result.reply).toBe('Private review card opened. Nothing has run.')
    expect(createMock).toHaveBeenCalledOnce()
    expect(runSpecialistMock).not.toHaveBeenCalled()
    expect(createMock.mock.calls[0][0].tools.map((tool: { name: string }) => tool.name)).toContain('open_kit_command')
  })
  it.each([{ command: 'exec', args: 'bad' }, { command: 'delete', args: 'project', userId: 'U_OTHER' }])('rejects invalid model command input', async input => {
    const openCommand = vi.fn()
    createMock.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'open_kit_command', input }] })
    const result = await runOrchestrator({ teamId: 'T1', channel: 'C1', userId: 'U1', user: fakeUser, message: 'help', openCommand })
    expect(openCommand).not.toHaveBeenCalled()
    expect(result.reply).toContain('nothing was run')
  })
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
      {
        channelId: 'C1',
        slackUserId: 'U1',
        workspaceId: undefined,
        isDirectMessage: false,
      },
    )
    const toolResult = createMock.mock.calls[1][0].messages[2].content[0].content
    expect(toolResult).toContain('<untrusted_specialist_result>')
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
