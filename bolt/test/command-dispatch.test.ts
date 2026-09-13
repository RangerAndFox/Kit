import { describe, expect, it, vi } from 'vitest'
import type { App } from '@slack/bolt'
vi.mock('../../src/lib/inngest/agents/registry', async () => ({ ...await vi.importActual('../../src/lib/inngest/agents/registry'), dispatch: vi.fn() }))
import { dispatch } from '../../src/lib/inngest/agents/registry'
import { registerKitCommand, dispatchKitCommand, type CommandInvocation } from '../src/handlers/command-dispatch'
import { registerCommandHandlers } from '../src/handlers/commands'

describe('one canonical command implementation', () => {
  it('invokes the identical handler for slash and natural command dispatch', async () => {
    const app = { command: vi.fn() } as unknown as App
    const handler = vi.fn().mockResolvedValue(undefined)
    const context = {} as CommandInvocation
    registerKitCommand(app, '/kit', handler)
    expect(app.command).toHaveBeenCalledWith('/kit', handler)
    await dispatchKitCommand(app, '/kit', context)
    expect(handler).toHaveBeenCalledWith(context)
  })
  it('cannot dispatch an unregistered handler', async () => {
    await expect(dispatchKitCommand({} as App, '/kit', {} as CommandInvocation)).rejects.toThrow('not registered')
  })
  it('runs real help and storyboard-resume validation without creating provider objects', async () => {
    const app = { command: vi.fn(), client: {} } as unknown as App
    registerCommandHandlers(app)
    const ack = vi.fn()
    const respond = vi.fn()
    const invocation = { ack, respond, client: app.client, command: { text: 'help', user_id: 'U_TEST', channel_id: 'D_TEST', team_id: 'T_TEST', trigger_id: 'click' } } as unknown as CommandInvocation
    await dispatchKitCommand(app, '/kit', invocation)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('natural language welcome') }))
    invocation.command.text = 'resume'
    await dispatchKitCommand(app, '/storyboard', invocation)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('resume <jobId>') }))
    expect(dispatch).not.toHaveBeenCalled()
  })
})
