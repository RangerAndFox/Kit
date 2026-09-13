import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT_COMMANDS, OPEN_KIT_COMMAND_TOOL, parseFastCommand, commandRequestSchema, isCommandRequest } from '../src/handlers/command-catalog'
import { normalizeDmShortcutText } from '../src/handlers/messages'
import { parseRoleIntent } from '../src/roles/keyword'
import { parseFrameioToggleIntent } from '../src/delivery/frameio-toggle'

describe('all-command natural language catalog', () => {
  it('covers every real slash command and alias; fails when a command is added without catalog coverage', () => {
    const source = readFileSync(join(__dirname, '../src/handlers/commands.ts'), 'utf8')
    const aliases: Record<string, string> = { control: 'dashboard', new: 'newproject', edit: 'update', publish: 'archive', accessibility: 'access', syncstaff: 'sync-staff', syncprojects: 'sync-projects', backfilltime: 'backfill-time' }
    const actual = [...new Set([...source.matchAll(/case '([^']+)':/g)].map(m => aliases[m[1]] || m[1]))].sort()
    expect(Object.keys(KIT_COMMANDS).filter(name => name !== 'storyboard').sort()).toEqual(actual)
    expect(source).toContain("registerKitCommand(app, '/storyboard'")
    expect((OPEN_KIT_COMMAND_TOOL.input_schema.properties.command as { enum: string[] }).enum.sort()).toEqual(Object.keys(KIT_COMMANDS).sort())
  })
  it.each([
    ['Kit, show me the dashboard', 'dashboard', ''],
    ['Could you open the control center?', 'dashboard', ''],
    ['Kit, what can you do?', 'help', ''],
    ['Please edit project 9999', 'update', '9999'],
    ['Archive project 9999', 'archive', '9999'],
    ['Please delete project 9999', 'delete', 'project'],
    ['Add a new freelancer', 'onboard', ''],
    ['Onboard Alex alex@example.com to 9999', 'onboard', 'Alex alex@example.com to 9999'],
    ['Show me the status of project 9999', 'status', '9999'],
    ['Create a new storyboard', 'storyboard', ''],
    ['Resume storyboard job test-id', 'storyboard', 'resume test-id'],
    ['Show me the delivery queue', 'deliver', 'status'],
    ['Transcode a video', 'deliver', ''],
    ['List delivery profiles', 'profiles', ''],
    ['Create a new delivery profile', 'profiles', 'create'],
    ['Show me the render workers', 'workers', ''],
    ['Render an After Effects project', 'render', ''],
    ['Check render jobs', 'render', 'status'],
    ['Show accessibility status', 'access', 'status'],
    ['Convert my SRT to VTT', 'access', 'convert'],
    ['Celebrate we finished the cut', 'celebrate', 'we finished the cut'],
    ['Save birthday for <@U123> 03-14', 'birthday', '<@U123> 03-14'],
    ['Refresh the project brain', 'brain', ''],
    ['Please give <@U123> admin access', 'role', '<@U123> admin'],
    ['Sync staff with Harvest', 'sync-staff', ''],
    ['Preview projects from Harvest', 'sync-projects', ''],
    ['Preview missing time logs', 'backfill-time', ''],
    ['Post a timesheet meme', 'meme', ''],
    ['Remember that client approved boards for 9999', 'note', '9999 | client approved boards'],
    ['pilot readiness', 'pilot', 'readiness'],
  ])('%s → %s', (text, command, args) => {
    expect(parseFastCommand(text)).toEqual({ command, args })
    expect(isCommandRequest(text)).toBe(true)
  })
  it.each([
    '4 hours on a new project yesterday', 'I spent 2h editing the storyboard',
    'Please do not delete project 9999', 'Never sync projects',
    'How do I delete a project?', 'If we finish, archive project 9999',
    '"post a meme"', '> give <@U123> admin access', 'Allyson said make <@U123> an admin',
    'Do not turn off auto upload for 9999',
  ])('does not dispatch quoted/negative/incidental text: %s', (text) => {
    expect(parseFastCommand(text)).toBeNull()
  })
  it('preserves the target mention, removing only real relay attribution', () => {
    expect(normalizeDmShortcutText('role <@U123>')).toBe('role <@U123>')
    expect(normalizeDmShortcutText('role <@U123>\nSent using <@UCHATGPT>')).toBe('role <@U123>')
    expect(normalizeDmShortcutText('new project\n<@UCHATGPT>')).toBe('new project')
  })
  it.each(['don’t make <@U123> an admin', 'Allyson said make <@U123> a producer', 'How do I give <@U123> admin access?'])('does not let negative/examples fall into the legacy role mutator: %s', text => {
    expect(parseRoleIntent(text)).toBeNull()
  })
  it.each(['do not turn off Frame.io upload', 'If we finish, disable auto upload for 9999'])('rejects a negated/conditional upload toggle: %s', text => {
    expect(parseFrameioToggleIntent(text)).toBeNull()
  })
  it.each([{ command: 'shell', args: 'rm -rf /' }, { command: 'help', args: '', user_id: 'U_OTHER' }, { command: 'help', args: 'x'.repeat(1601) }])('rejects model-supplied execution authority and malformed inputs', input => {
    expect(commandRequestSchema.safeParse(input).success).toBe(false)
  })
})
