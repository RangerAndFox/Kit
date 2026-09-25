import { expect, it } from 'vitest'
import { buildRequesterSummary } from './summary'

it('surfaces the signup handoff even when Slack invite and welcome failed', () => {
  const result = buildRequesterSummary({ artistName: 'Artist', artistEmail: 'artist@example.com', projectName: 'Project', results: {
    slack: { status: 'failed', message: 'An admin must invite this artist as a guest.' },
    frameio: { status: 'failed', message: 'Share the signup link; no access granted yet.', actionUrl: 'https://next.frame.io/join/example', actionLabel: 'Sign up' },
    welcomeDm: { status: 'skipped', message: 'No welcome sent.' },
  } })
  expect(result).toContain('https://next.frame.io/join/example')
  expect(result).toContain('Action needed: Sign up')
  expect(result).toContain('No welcome sent')
  expect(result).not.toContain('sent to them')
})
