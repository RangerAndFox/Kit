import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KIT_COMMANDS } from '../src/handlers/command-catalog'
import type { KitCommandName } from '../src/handlers/command-catalog'
import { COMMAND_GUIDES, guidanceBlocks, guidanceText, guidanceRequestSchema, isGuidanceQuestion, parseGuidanceCommand } from '../src/handlers/command-guidance'
import { clearGuidanceInvitation, consumeGuidanceReply, pendingGuidance, rememberGuidanceInvitation } from '../src/handlers/guidance-followup'
import { resetMemoryForTest } from '../src/llm/memory'

describe('maintained function guidance', () => {
  it('covers every command with product steps rather than internal command grammar', () => {
    expect(Object.keys(COMMAND_GUIDES).sort()).toEqual(Object.keys(KIT_COMMANDS).sort())
    for (const command of Object.keys(KIT_COMMANDS) as KitCommandName[]) {
      expect(COMMAND_GUIDES[command].steps.length).toBeGreaterThanOrEqual(3)
      expect(guidanceText(command, 'admin')).toContain('?')
      expect(guidanceText(command, 'admin').length).toBeLessThan(3000)
    }
  })
  it.each([
    ['How do I onboard an artist?', 'onboard'], ['Kit, can you walk me through adding a freelancer?', 'onboard'],
    ['Could you explain onboarding?', 'onboard'], ['I need some pointers on onboarding', 'onboard'],
    ['What does onboarding do?', 'onboard'], ['Tell me about onboarding', 'onboard'], ['What do I need to onboard an artist?', 'onboard'],
    ['How do I create a new project?', 'newproject'], ['Show me how to edit a project', 'update'],
    ['How does archiving work?', 'archive'], ['How do I delete a project?', 'delete'],
    ['How can I use the dashboard?', 'dashboard'], ['How do I make a storyboard?', 'storyboard'],
    ['Tell me how to convert SRT files', 'access'], ['How do I use delivery profiles?', 'profiles'],
    ['How does project tracking work?', 'status'], ['How do I post a meme?', 'meme'],
  ])('maps %s to read-only %s instructions', (question, command) => {
    expect(isGuidanceQuestion(question)).toBe(true)
    expect(parseGuidanceCommand(question)).toBe(command)
  })
  it.each(['Please onboard an artist', 'Create a new project', '4 hours on Fabric', 'How many hours did I log?', 'How much budget is left?', 'What is the project status?', 'show me the dashboard'])('does not turn an action or data query into instructions: %s', text => {
    expect(isGuidanceQuestion(text)).toBe(false)
    expect(parseGuidanceCommand(text)).toBeNull()
  })
  it('leaves multiple/unknown topics for clarification', () => {
    expect(parseGuidanceCommand('How do I create a storyboard and delete a project?')).toBeNull()
    expect(parseGuidanceCommand('How does the thing we discussed work?')).toBeNull()
  })
  it('offers no action to artists for producer/admin features, but still teaches', () => {
    expect(guidanceText('onboard', 'artist')).toContain('correct full name and email')
    expect(guidanceText('onboard', 'artist')).toContain('Producer/admin only')
    expect(guidanceText('onboard', 'artist')).not.toContain('Want me to open')
    expect(guidanceBlocks('onboard', 'artist')).toHaveLength(1)
    expect(guidanceBlocks('delete', 'producer')).toHaveLength(1)
    expect(guidanceBlocks('onboard')).toHaveLength(1)
    expect(guidanceBlocks('onboard', 'producer')).toHaveLength(2)
  })
  it('does not accept actors, action arguments or arbitrary guide names from the model', () => {
    expect(guidanceRequestSchema.safeParse({ command: 'onboard', args: 'private@example.test' }).success).toBe(false)
    expect(guidanceRequestSchema.safeParse({ command: 'onboard', userId: 'U_OTHER' }).success).toBe(false)
    expect(guidanceRequestSchema.safeParse({ command: '__proto__' }).success).toBe(false)
  })
  it('keeps risky defaults non-destructive and does not promise provider success', () => {
    expect(COMMAND_GUIDES['backfill-time'].start?.args).toBe('')
    expect(COMMAND_GUIDES['sync-projects'].start?.args).toBe('')
    expect(COMMAND_GUIDES.delete.start?.args).toBe('project')
    expect(guidanceText('delete', 'admin')).toContain('typed confirmation')
    expect(guidanceText('onboard', 'producer')).toContain('Check the per-service result')
    expect(guidanceText('access', 'producer')).toContain('does not run a conversion')
  })
})

describe('thread-bound guidance invitations', () => {
  const scope = { teamId: 'T1', channelId: 'D1', userId: 'U1', threadTs: '1.0' }
  beforeEach(() => { resetMemoryForTest(); vi.useFakeTimers() })
  afterEach(() => vi.useRealTimers())
  it.each(['yes', 'Yes please!', 'sure', 'let’s do it', 'go ahead', 'start privately'])('accepts %s only for the offered function', text => {
    rememberGuidanceInvitation(scope, 'onboard')
    expect(consumeGuidanceReply(scope, text)).toEqual({ command: 'onboard', start: true })
    expect(consumeGuidanceReply(scope, text)).toBeNull()
  })
  it.each(['no', 'not now', 'cancel', 'no thanks'])('declines %s with no command', text => {
    rememberGuidanceInvitation(scope, 'onboard')
    expect(consumeGuidanceReply(scope, text)).toEqual({ command: 'onboard', start: false })
  })
  it('does not borrow a yes from another user, team, channel or thread', () => {
    rememberGuidanceInvitation(scope, 'onboard')
    for (const changed of [{ userId: 'U2' }, { teamId: 'T2' }, { channelId: 'D2' }, { threadTs: '2.0' }, { threadTs: undefined }]) {
      expect(consumeGuidanceReply({ ...scope, ...changed }, 'yes')).toBeNull()
    }
    expect(pendingGuidance(scope)).toBe('onboard')
  })
  it('expires and cancels on an intervening topic or a button action', () => {
    rememberGuidanceInvitation(scope, 'onboard')
    vi.advanceTimersByTime(16 * 60 * 1000)
    expect(consumeGuidanceReply(scope, 'yes')).toBeNull()
    rememberGuidanceInvitation(scope, 'onboard')
    expect(consumeGuidanceReply(scope, '4 hours on the project')).toBeNull()
    expect(consumeGuidanceReply(scope, 'yes')).toBeNull()
    rememberGuidanceInvitation(scope, 'onboard')
    clearGuidanceInvitation(scope)
    expect(consumeGuidanceReply(scope, 'yes')).toBeNull()
  })
})
