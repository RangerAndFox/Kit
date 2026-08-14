/**
 * Keyword-shortcut REGISTRATION PARITY between the two inbound DM paths.
 *
 * Kit receives a direct message through one of two paths depending on Slack app
 * config, and a keyword shortcut must be registered in BOTH:
 *
 *   1. `app.assistant(...)`'s `userMessage` callback in `bolt/src/app.ts` —
 *      used when "Agents & AI Apps" is enabled (it is), so this is the LIVE
 *      path for DMs today.
 *   2. the `isDM && is*Trigger(...)` branches in `handlers/messages.ts` —
 *      plain `message` events, the path used when the Assistant is off.
 *
 * Registering in only one silently degrades to the conversational orchestrator
 * instead of posting the card. That is exactly what happened to
 * `isUpdateProjectTrigger`: it shipped wired into messages.ts only, so
 * "update project" in a DM answered "Which project, and what's the update?"
 * rather than opening the picker.
 *
 * This is deliberately a SOURCE-LEVEL check (unlike route-registration.test.ts,
 * which imports its canonical list): `app.ts` boots the Slack App at module
 * load, so it cannot be imported here. If the Assistant callback is ever
 * extracted into an importable module, replace this with a structural test.
 *
 * Run: npx vitest run test/assistant-shortcut-parity.test.ts
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', 'src')
const appTs = readFileSync(join(SRC, 'app.ts'), 'utf8')
const messagesTs = readFileSync(join(SRC, 'handlers', 'messages.ts'), 'utf8')

/** Every keyword trigger that gates a DM shortcut. Add new ones here. */
const TRIGGERS = ['isStoryboardTrigger', 'isNewProjectTrigger', 'isUpdateProjectTrigger']

/** Body of the Assistant `userMessage` callback in app.ts. */
function assistantUserMessageBody(): string {
  const start = appTs.indexOf('userMessage:')
  expect(start, 'app.ts should register an Assistant userMessage callback').toBeGreaterThan(-1)
  // Up to the end of the Assistant construction — enough to cover the callback.
  const end = appTs.indexOf('app.assistant(', start)
  return appTs.slice(start, end > start ? end : undefined)
}

describe('DM keyword shortcuts are registered on BOTH inbound paths', () => {
  const assistantBody = assistantUserMessageBody()

  for (const trigger of TRIGGERS) {
    it(`${trigger} is consulted in the Assistant userMessage callback (the live DM path)`, () => {
      expect(
        assistantBody.includes(trigger),
        `${trigger} is missing from app.ts's Assistant userMessage callback. With ` +
          `"Agents & AI Apps" enabled, DMs arrive there — a shortcut wired only into ` +
          `messages.ts will never fire and the message falls through to the orchestrator.`,
      ).toBe(true)
    })

    it(`${trigger} is consulted in the plain-message handler`, () => {
      expect(
        messagesTs.includes(trigger),
        `${trigger} is missing from handlers/messages.ts, so the shortcut would not ` +
          `work if the Assistant flow is ever disabled.`,
      ).toBe(true)
    })
  }
})
