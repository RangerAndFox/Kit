/**
 * Structural coverage for the two Slack DM entry points.
 *
 * Strict card shortcuts live in one importable registry. The Assistant callback
 * and the plain-message fallback must both call the same dispatcher; neither
 * entry point is allowed to maintain its own trigger list.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DM_SHORTCUT_REGISTRY } from '../src/handlers/messages'

const SRC = join(__dirname, '..', 'src')
const appTs = readFileSync(join(SRC, 'app.ts'), 'utf8')
const messagesTs = readFileSync(join(SRC, 'handlers', 'messages.ts'), 'utf8')

describe('DM keyword shortcut registry', () => {
  it('contains every supported strict card shortcut in routing order', () => {
    expect(DM_SHORTCUT_REGISTRY.map((shortcut) => shortcut.id)).toEqual([
      'storyboard',
      'new-project',
      'update-project',
    ])
  })

  it('routes the Assistant callback through the shared dispatcher', () => {
    const callbackStart = appTs.indexOf('userMessage:')
    expect(callbackStart).toBeGreaterThan(-1)
    const callbackBody = appTs.slice(callbackStart, appTs.indexOf('app.assistant(', callbackStart))
    expect(callbackBody).toContain('handleDmShortcut(app,')
  })

  it('routes the plain-message fallback through the shared dispatcher', () => {
    const handlerStart = messagesTs.indexOf("app.event('message'")
    expect(handlerStart).toBeGreaterThan(-1)
    const handlerBody = messagesTs.slice(handlerStart, messagesTs.indexOf('export async function handleConversationalMessage'))
    expect(handlerBody).toContain('handleDmShortcut(app,')
  })

  it('keeps trigger matching inside the registry rather than app.ts', () => {
    expect(appTs).not.toMatch(/is(?:Storyboard|NewProject|UpdateProject)Trigger/)
  })
})
