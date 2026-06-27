import { describe, it, expect } from 'vitest'

import { buildBriefingText } from '../../src/lib/agent/briefing-composer'

const event: any = {
  summary: 'Rayfin client review',
  start_time: '2026-06-25T17:00:00Z',
  attendees: [{ email: 'client@acme.com' }, { email: 'jared@rangerandfox.tv' }],
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
}

describe('buildBriefingText', () => {
  it('renders project header, attendees, actions, and the project recap', () => {
    const text = buildBriefingText({
      event,
      project: { name: 'Rayfin', client: 'Acme', project_code: '2620', brief_summary: 'Sizzle reel', external_links: {} },
      actions: [{ title: 'Send v2 for approval' }],
      lastTranscript: { start_time: '2026-06-20T17:00:00Z', transcript: 'We discussed the edit timeline.' },
    })
    expect(text).toContain('Rayfin client review')
    expect(text).toContain('*Project:* Rayfin (Acme) — 2620')
    expect(text).toContain('Send v2 for approval')
    expect(text).toContain('Last meeting')
    expect(text).toContain('We discussed the edit timeline.')
    expect(text).toContain('client@acme.com')
  })

  it('accepts both the *_url and bare external_links keys', () => {
    const urlKeys = buildBriefingText({
      event,
      project: { name: 'P', external_links: { frameio_url: 'https://f.io/x', dropbox_url: 'https://db/x' } },
      actions: null,
      lastTranscript: null,
    })
    expect(urlKeys).toContain('Frame.io: https://f.io/x')
    expect(urlKeys).toContain('Dropbox: https://db/x')

    const bareKeys = buildBriefingText({
      event,
      project: { name: 'P', external_links: { frameio: 'https://f.io/y', dropbox: 'https://db/y' } },
      actions: null,
      lastTranscript: null,
    })
    expect(bareKeys).toContain('Frame.io: https://f.io/y')
    expect(bareKeys).toContain('Dropbox: https://db/y')
    // Google Meet link always comes from the event.
    expect(bareKeys).toContain('meet.google.com')
  })

  it('truncates a long recap to 400 chars with an ellipsis', () => {
    const long = 'x'.repeat(600)
    const text = buildBriefingText({
      event,
      project: { name: 'P', external_links: {} },
      actions: null,
      lastTranscript: { start_time: '2026-06-20T17:00:00Z', transcript: long },
    })
    expect(text).toContain('x'.repeat(400) + '…')
    expect(text).not.toContain('x'.repeat(401))
  })

  it('omits sections that have no data', () => {
    const text = buildBriefingText({
      event: { ...event, attendees: [], hangoutLink: undefined },
      project: null,
      actions: null,
      lastTranscript: null,
    })
    expect(text).not.toContain('*Project:*')
    expect(text).not.toContain('*Links:*')
    expect(text).not.toContain('*Attendees:*')
    expect(text).not.toContain('*Last meeting')
  })
})
